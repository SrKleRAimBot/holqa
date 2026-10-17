---
name: schema-evolution
description: Changes Holqa queue message schemas, HTTP and RPC contracts, and environment schemas without breaking messages already in flight, dead-letter queues, or deployed clients — using schemaVersion, additive changes, and staged migrations. Use before editing any schema attached to a queue, route, procedure or variable.
license: Apache-2.0
metadata:
  status: preview
---

# Evolving schemas safely

> **Preview — not yet available.** Schema fingerprints, compatibility diagnostics and versioned message decoding are **planned** compiler features. Nothing checks compatibility automatically today; apply this workflow by review.

## When to use

- Adding, removing, renaming or retyping a field in a queue `message` schema.
- Changing the `input`/`output` of an RPC procedure or the request/response of an HTTP route.
- Tightening validation on an existing contract.

## Why types are not enough

TypeScript checks the code you are deploying. It cannot see messages written by the previous deployment that are still in a queue or dead-letter queue, or frontends that users have not reloaded. Runtime validation catches bad data; this workflow avoids producing it.

## Works today

Nothing Holqa-specific. You can test schemas directly: keep fixtures of every previous message shape and assert the new schema still parses them (`schema.safeParse(fixture).success`).

## Planned workflow

1. **Classify the change.**

   | Change | Producers → consumers | Safe in one deploy? |
   | --- | --- | --- |
   | Add optional field / field with default | Old messages still parse | Yes |
   | Add required field | Old messages fail | No — stage it |
   | Remove field consumers read | New messages fail old consumers | No — stage it |
   | Rename field | Both of the above | No — add new, migrate, remove old |
   | Narrow a type or enum | Old values fail | No |
   | Widen an enum consumers switch on | Old consumers see unknown values | Usually no |

2. **For breaking queue changes, bump `schemaVersion`** and accept both shapes in the consumer until the old version has drained, including the dead-letter queue.
3. **Deploy consumers before producers.** Consumers must understand the new shape before anything sends it.
4. **Remove the old shape** only after confirming no old messages remain.
5. **For HTTP/RPC, keep deployed clients working**: additive outputs, optional inputs, or a new route/procedure `id` for incompatible behavior.
6. **Review compiler diagnostics** once the planned compatibility checks exist.

```ts
// infra.ts — illustrative, proposed API: version 2 adds a required currency
const orderV1 = z.object({ orderId: z.string(), priority: z.enum(["normal", "urgent"]) });
const orderV2 = orderV1.extend({ currency: z.string().length(3) });

orders: queue({
  id: "order-processing",
  message: z.union([orderV2, orderV1.transform(m => ({ ...m, currency: "EUR" }))]),
  schemaVersion: 2,
  delivery: { maxAttempts: 5, deadLetter: true }
})
```

Transforms like the one above may not be representable as portable JSON Schema; the planned compiler is expected to report such schemas explicitly rather than approximate them.

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
