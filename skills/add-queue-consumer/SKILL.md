---
name: add-queue-consumer
description: Sends messages to a Holqa queue resource and registers its idempotent competing consumer with retries, backoff, concurrency and dead-letter handling. Use when moving work to the background, processing jobs asynchronously, or fixing duplicate or lost queue processing.
license: Apache-2.0
metadata:
  status: preview
---

# Adding a queue consumer

> **Preview — not yet available.** `queue(...)`, `resources.x.send` and `resources.x.consume` are a **proposed** API, and `holqa queue send` is a proposed command. Nothing here runs yet; code is illustrative.

## When to use

- Deferring slow or failure-prone work out of an HTTP request.
- Processing jobs with retries and a dead-letter queue.
- Reviewing a consumer for duplicate-delivery safety.

A queue has **one** competing consumer. If several independent subscribers must react to the same event, that is fan-out, which belongs to a future topic resource, not a queue.

## Works today

Only ID validation: queue and consumer IDs must match `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$` (at most 63 characters). `holqa queue send --json` reports `HOLQA_CLI_NOT_IMPLEMENTED`.

## Planned workflow

1. **Declare the queue** in `infra.ts` with a `message` schema, `schemaVersion` and delivery policy (see `define-resources`).
2. **Send** from any server-side handler: `await resources.orders.send(message)`. The message type is inferred from the schema; no parallel interface is needed.
3. **Create the consumer** in its own `*.handler.ts` file with a stable `id` and the delivery context.
4. **Make it idempotent.** Record a deduplication key in the same transaction as the side effect.
5. **Decide on failures.** Throw to retry; let poison messages reach the dead-letter queue after `maxAttempts`.
6. **Test duplicates and retries** (see `testing-event-driven-apps`), then try it locally with `holqa queue send` (proposed).

```ts
// src/orders/process-order.handler.ts — illustrative, proposed API
import { resources } from "../../infra";
import { sql } from "../db";

export default resources.orders.consume({
  id: "orders.process",
  concurrency: 4,
  handler: async ({ message, delivery, log }) => {
    await sql.begin(async (tx) => {
      const claimed = await tx`
        INSERT INTO processed_orders (order_id) VALUES (${message.orderId})
        ON CONFLICT (order_id) DO NOTHING RETURNING order_id`;
      if (claimed.length === 0) {
        log.info("Duplicate delivery skipped", { attempt: delivery.attempt });
        return;
      }
      await tx`UPDATE orders SET status = 'processing' WHERE id = ${message.orderId}`;
    });
  }
});
```

Full example: [`examples/basic-backend`](../../examples/basic-backend/).

## Pitfalls

- **Assuming exactly-once.** Delivery is at-least-once in every environment, including local emulation. A message can arrive twice, concurrently, or after a later message.
- **Claiming before doing.** Marking a message processed in a separate step from the side effect loses work if the handler fails in between. Use one transaction, or make the side effect itself idempotent (for example, an idempotency key on an external payment API).
- **Swallowing errors.** Catching and ignoring errors acknowledges the message; it will never be retried.
- **Non-retryable errors that retry forever.** Validation failures should go to the dead-letter queue quickly, not consume all attempts with backoff.
- **Large payloads.** Send identifiers and store bulky data in a bucket or database.
- **Schema drift.** Messages already in the queue were written with the old schema; see `schema-evolution`.
- **Secrets in messages.** Messages may be logged, inspected and dead-lettered; never include credentials.

## Verification checklist

- [ ] The queue declares `message`, `schemaVersion`, `maxAttempts` and dead-letter behavior.
- [ ] Exactly one consumer is registered for the queue, with a stable `id`.
- [ ] Processing the same message twice produces the same final state.
- [ ] Errors either propagate (retry) or are deliberately dead-lettered; none are silently swallowed.
- [ ] Concurrency is set with downstream limits (database connections, rate limits) in mind.
- [ ] Messages contain no secrets or unnecessary personal data.
