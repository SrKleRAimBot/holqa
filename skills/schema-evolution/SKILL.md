---
name: schema-evolution
description: Changes Holqa queue message schemas, HTTP and RPC contracts, and environment schemas without breaking messages already in flight, dead-letter queues, or deployed clients — using schemaVersion, additive changes, and staged migrations. Use before editing any schema attached to a queue, route, procedure or variable.
license: Apache-2.0
metadata:
  status: preview
---

# Evolving schemas safely

> **Preview.** Schema fingerprints, the compatibility checker and versioned message codecs exist as library functions in `@holqa/compiler`, `@holqa/core` and `@holqa/zod` (private, unpublished packages). The compiler records each contract's fingerprint in the manifest (`holqa build --manifest`), but nothing compares a deployment with the previous one yet. Call them from a test, as shown below.

## When to use

- Adding, removing, renaming or retyping a field in a queue `message` schema.
- Changing the `input`/`output` of an RPC procedure or the request/response of an HTTP route.
- Tightening validation on an existing contract.

## Why types are not enough

TypeScript checks the code you are deploying. It cannot see messages written by the previous deployment that are still in a queue or dead-letter queue, or frontends that users have not reloaded. Runtime validation catches bad data; this workflow avoids producing it.

## Works today

Compare the deployed and the new schema in a test. The checker classifies each change for the contract's role (`message`, `request` or `response`) and fails on a breaking change unless `schemaVersion` was increased:

```ts
import { checkSchemaCompatibility, describeSchemaContract } from "@holqa/compiler";
import { zodAdapter } from "@holqa/zod";

const subject = "message for queue \"order-processing\"";
const previous = await describeSchemaContract(orderV1, { subject, schemaVersion: 1, adapters: [zodAdapter] });
const next = await describeSchemaContract(orderV2, { subject, schemaVersion: 1, adapters: [zodAdapter] });
if (previous.ok && next.ok) {
  const report = checkSchemaCompatibility(previous.value.record, next.value.record, { role: "message", subject });
  // report.compatible is false and report.diagnostics contains HOLQA_SCHEMA_CHANGE_BREAKING
  // with details.path "$.currency" and details.kind "required-property-added".
}
```

Keep fixtures of every previous message shape as well, and assert the new schema still parses them (`schema.safeParse(fixture).success`). The checker only reasons about the portable description; fixtures also cover refinements. The full policy is in [schema contracts](../../docs/reference/schema-contracts.md#evolution-guidance).

## Workflow

1. **Classify the change.**

   | Change | Producers → consumers | Safe in one deploy? |
   | --- | --- | --- |
   | Add optional field / field with default | Old messages still parse | Yes, unless old consumers reject undeclared fields |
   | Add required field | Old messages fail | No — stage it |
   | Remove field consumers read | New messages fail old consumers | No — stage it |
   | Rename field | Both of the above | No — add new, migrate, remove old |
   | Narrow a type or enum | Old values fail | No |
   | Widen an enum consumers switch on | Old consumers see unknown values | Usually no |

2. **For breaking queue changes, bump `schemaVersion`** and accept both shapes in the consumer until the old version has drained, including the dead-letter queue.
3. **Deploy consumers before producers.** Consumers must understand the new shape before anything sends it.
4. **Remove the old shape** only after confirming no old messages remain.
5. **For HTTP/RPC, keep deployed clients working**: additive outputs, optional inputs, or a new route/procedure `id` for incompatible behavior.
6. **Run the compatibility check** in a test (above). The manifest records fingerprints, so a changed fingerprint in `manifest.json` signals a contract change to review; comparing against the previous deployment automatically is planned.

```ts
// infra.ts: version 2 adds a required currency
const orderV1 = z.object({ orderId: z.string(), priority: z.enum(["normal", "urgent"]) });
const orderV2 = orderV1.extend({ currency: z.string().length(3) });

orders: queue({
  id: "order-processing",
  message: z.union([orderV2, orderV1.transform(m => ({ ...m, currency: "EUR" }))]),
  schemaVersion: 2,
  delivery: { maxAttempts: 5, deadLetter: true }
})
```

A transform like the one above has no portable decoded side. The normalizer still describes its wire side and records the decoded side as unrepresentable, rather than approximating it.

## Pitfalls

- Changing a queue schema and its producer in the same deploy as an incompatible consumer.
- Forgetting the dead-letter queue, which can hold very old messages.
- Reusing a procedure `id` for different semantics.
- Tightening validation (shorter max length, new regex) without checking existing data.
- Changing env schemas so that existing deployments fail to start.

## Verification checklist

- [ ] The change is classified as compatible or breaking, with the reason written down.
- [ ] Fixtures of every previous message shape still parse.
- [ ] `schemaVersion` was bumped for breaking queue changes.
- [ ] Rollout order (consumers first) and the condition for removing the old shape are documented.
- [ ] Public HTTP/RPC changes are additive, or exposed under a new `id`/route.
