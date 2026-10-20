# Migrating to binding configurations

> **Status:** **Implemented.** Binding configurations (`@holqa/bindings`) are additive: every earlier way of running an application keeps working, and no handler changes are needed.

Earlier, a runtime received one binding object directly: the default environment binding, or `createLocalEnvironment(...).binding`. Binding configurations select a provider per resource kind, per resource and per service, validate the selection before anything runs, and are what `holqa dev --bindings`, `holqa package` and `holqa provision` work with.

## What stays the same

| You use | It still works | Notes |
| --- | --- | --- |
| `createRuntime({ app, handlers })` | Yes | Uses the default environment binding, as before. |
| `createRuntime({ ..., binding: localEnv.binding })` with `createLocalEnvironment` | Yes | The local environment is the same engine as the local providers. |
| `createTestApp` from `@holqa/testing` | Yes | Add `persistence: "memory"` for faster, isolated tests, and `withFaults` to inject provider failures. |
| `holqa dev` without `--bindings` | Yes | It now composes `local.platform()` through the binding layer; behaviour is the same. |
| Handlers and resource handles | Yes | They never name providers, so nothing changes. |

## Step by step

1. **Describe the local environment as a configuration.** Next to `infra.ts`, create `bindings.ts`:

   ```ts
   import { defineBindings } from "@holqa/bindings";
   import { local } from "@holqa/local";
   import app from "./infra";

   export default defineBindings(app, { name: "local", defaults: local.platform() });
   ```

   `holqa bindings inspect` shows which provider binds each resource and why; `holqa bindings validate` reports anything a provider cannot satisfy.

2. **Run development through it.** `holqa dev --bindings bindings.ts` behaves like `holqa dev`, and lets you replace individual providers, for example a real broker for queues while everything else stays local:

   ```ts
   export default defineBindings(app, {
     name: "local-with-broker",
     defaults: local.platform(),
     kinds: { queue: rabbitmq.queues({ url: credentialRef("QUEUE_URL"), delayedDelivery: "delay-queues" }) }
   });
   ```

3. **Add a configuration per environment.** For example `bindings.production.ts` with `container.host()`, external providers, `environmentConfig()` or `container.secretFiles()`, `otlp.telemetry(...)` and `replicas`. Keep settings that differ between environments in the configuration, and secrets in credential references.

4. **Replace hand-written servers with packaging.** A `server.ts` that loads `holqa build --manifest` output and calls `serve` can stay. To deploy a container instead, use `holqa package --bindings bindings.production.ts`, which adds artifact verification, binding drift checks, probes and graceful shutdown ([container runtime](../reference/container.md)).

5. **Optionally, provision.** If you created queues and buckets by hand or with other tools, keep doing so. Otherwise add `provisioning.ts` with the RabbitMQ and S3 provisioners and review `holqa provision plan` before `holqa provision apply` ([provisioning](../reference/provisioning.md)).

## Behaviour to be aware of

| Topic | Change |
| --- | --- |
| Unmet requirements | A binding configuration rejects providers that cannot satisfy a declared requirement before start (`HOLQA_BINDING_CAPABILITY_UNSUPPORTED`), never weakening it. Emulations, such as RabbitMQ delay queues, must be enabled explicitly. |
| Background handlers | A handler whose resource's provider delivers no events is rejected (`HOLQA_BINDING_TOPOLOGY_UNSUPPORTED`). |
| Missing infrastructure | External providers never create queues or buckets; a missing one fails the start with `HOLQA_BINDING_FAILED`. |
| Credentials | External providers accept credential references only. Plain strings for URLs or keys are rejected. |
| Static sites | `createBinding` now serves `static.site` drivers; configurations with static sites that failed to serve them before now work. |

## Related

- [Binding contracts](../reference/bindings.md)
- [Operations guide](operations.md)
- [Local development guide](local-development.md)
