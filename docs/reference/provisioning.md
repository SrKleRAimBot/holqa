# Provisioning

> **Status:** **Implemented** in `@holqa/core`, `@holqa/bindings`, `@holqa/rabbitmq`, `@holqa/s3` and `holqa provision`. The design is recorded in [ADR 0034](../architecture/decisions/0034-provisioning-separate-from-runtime-bindings.md).

Provisioning is optional and separate from running. Runtime providers connect to infrastructure that exists, whoever created it. A provisioning configuration lets Holqa create what its providers expect, with credentials the runtime never receives.

## Configuration

A provisioning module, conventionally `provisioning.ts` next to `infra.ts`, exports a configuration for one binding configuration:

```ts
import { defineProvisioning } from "@holqa/bindings";
import { credentialRef } from "@holqa/core";
import { rabbitmq } from "@holqa/rabbitmq";
import { s3 } from "@holqa/s3";
import bindings from "./bindings.production";

export default defineProvisioning(bindings, {
  provisioners: [
    rabbitmq.provisioner({ url: credentialRef("RABBITMQ_ADMIN_URL") }),
    s3.provisioner({
      accessKeyId: credentialRef("S3_ADMIN_ACCESS_KEY_ID"),
      secretAccessKey: credentialRef("S3_ADMIN_SECRET_ACCESS_KEY"),
      notifications: { target: "arn:minio:sqs::primary:amqp" }
    })
  ]
});
```

Each provisioner claims the resources bound to runtime providers it understands and derives the infrastructure from those providers' settings and the application's handlers, so names always agree with what the runtime expects. A resource no provisioner claims is listed as unprovisioned: it must exist.

## Plans

`planProvisioning(definition, { handlers, lookup })` only reads infrastructure and returns a `holqa.provisioning-plan/1` plan:

| Field | Content |
| --- | --- |
| `binding`, `application` | The binding configuration's and the application's names. |
| `changes` | In apply order: `provisioner`, `type` (for example `rabbitmq.queue`), `target` (the physical name), `resource`, `action`, `destructive`, `reason` and `details` (desired settings, never credential values). |
| `unprovisioned` | `{ resource, provider }` for resources no provisioner manages. |
| `outputs` | Non-secret metadata by provisioner, for example queue names. |
| `diagnostics` | Problems; the plan can be applied when none is an error. |

| Action | Meaning | Destructive |
| --- | --- | --- |
| `create` | It does not exist. | No |
| `update` | It exists and is changed in place without data loss. | No |
| `replace` | It exists with settings that cannot be changed in place; it would be deleted and created again, losing what it holds. | Yes |
| `delete` | It would be removed. No reference provisioner plans deletions. | Yes |
| `none` | It exists as needed. | No |

Removing a resource declaration never plans a deletion: provisioners only plan for declared resources, and there is no notion of orphans.

## Applying

`applyProvisioning(definition, { handlers, lookup, allowDestructive? })` plans again and applies nothing when the plan has errors, or has a destructive change and `allowDestructive` is not set (`HOLQA_PROVISIONING_DESTRUCTIVE`, one per change). Otherwise each provisioner applies its changes in order, skipping `none`; applying stops at the first failure (`HOLQA_PROVISIONING_FAILED`), and the `holqa.provisioning-result/1` result lists every attempted change with `applied`, `skipped` or `failed`.

A provisioner resolves only the credentials it declares; a missing one is `HOLQA_BINDING_CREDENTIALS_MISSING`, naming it without a value. Malformed configurations, provisioners of another protocol version and two provisioners managing one target are `HOLQA_PROVISIONING_CONFIG_INVALID`.

## Reference provisioners

| Provisioner | Manages | Plans |
| --- | --- | --- |
| [`rabbitmq.provisioner({ url, providers?, exchangeType?, routingKey? })`](providers/rabbitmq.md#provisioning) | Queues of `rabbitmq.queues` (main, dead-letter, delay queues with their arguments); for buckets with `rabbitmq.eventChannel`, the notification exchange and per-handler subscription queues bound to it. | `create`; `none`; `replace` for a queue or exchange with other arguments or type. Existing bindings are idempotent `update`s, because AMQP 0-9-1 cannot read them. |
| [`s3.provisioner({ accessKeyId, secretAccessKey, sessionToken?, providers?, notifications? })`](providers/s3.md#provisioning) | Buckets of `s3.buckets`; with `notifications.target`, one notification rule per bucket with object event handlers, for the event types they need. Other rules are kept. | `create`, `none`; `update` for the rule. Never destructive; never changes bucket policies. |

## Command line

`holqa provision plan` and `holqa provision apply [--allow-destructive]` run the module in a separate Bun process with the CLI's environment, where the administrative credentials are; see the [CLI reference](cli.md#holqa-provision-plan-and-holqa-provision-apply).

## Writing a provisioner

Implement `Provisioner` from `@holqa/core`: `provisioningProtocol` (`provisioningProtocolVersion`), `provisioner` (a namespaced identifier), `name`, optional `settings` and `credentials`, and:

| Member | Contract |
| --- | --- |
| `supports(provider, resource)` | Pure: whether it provisions this resource's infrastructure for this runtime provider. |
| `plan(context)` | Reads only. Returns every change, including `none`, with the action that applying would take. Classify anything that loses data as `replace` or `delete`. |
| `apply(context, changes)` | Applies only the given changes, in order, and stops at the first failure. |

`context` has the application, the environment name, the claimed `resources` with their runtime providers, the `handlers`, `credential(reference)`, a `signal` and `log`.
