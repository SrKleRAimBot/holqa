---
name: testing-event-driven-apps
description: Tests Holqa handlers deterministically with createTestApp — HTTP routes, RPC procedures, queue consumers, storage events and schedules — including duplicate deliveries, retries, injected failures, dead-lettering and a virtual clock. Use when adding tests for a handler, reproducing an event-processing bug, or proving that a consumer is idempotent.
license: Apache-2.0
metadata:
  status: preview
---

# Testing event-driven applications

> **Preview — not yet published.** `createTestApp` is **implemented** in `@holqa/testing` in the Holqa repository (unpublished, requires Bun); its API may change. It runs the application on the same runtime and local drivers as `holqa dev`, with an isolated state directory and a virtual clock.

## When to use

- Writing tests for a new handler.
- Proving idempotency of a consumer or storage event handler.
- Reproducing a retry, ordering or dead-letter bug without waiting for real retry intervals.

## Workflow

1. **Keep business logic in plain functions** and unit-test them with `bun test`; use `createTestApp` for behaviour across triggers.
2. **Create a test app per test** from the application and its handler registrations, and dispose of it afterwards. One application instance can run in one test app at a time.
3. **Trigger events through the real paths:** `fetch` for HTTP routes and procedures, `send` for queues, `put` for buckets, `trigger` for schedules. They validate input like a producer would. `invoke` runs a background handler once with generated metadata.
4. **Run the work and move time:** `flush()` runs everything due now; `advance(ms)` moves the virtual clock, stopping at each retry, delay and schedule; `drain()` advances until no message or event is waiting.
5. **Inject failures and duplicates:** `failNext(handlerId, { times, error, when })`, `duplicate(queueId, messageId)`, `duplicateEvent(bucketId, handlerId, eventId)`, `redrive(queueId)`.
6. **Assert on outcomes:** `messages`, `deadLetters`, `objects`, `read`, `events`, `runs`, and `invocations()` / `trace(correlationId)`, which read the structured logs (outcome, attempt, `causationId`, emitted messages and objects).

```ts
import { createTestApp } from "@holqa/testing";
import { afterEach, beforeEach, expect, it } from "bun:test";
import app from "@/app/infra";
import { placeOrder, processOrder } from "@/app/src/orders.handler";

let test: Awaited<ReturnType<typeof createTestApp>>;
beforeEach(async () => {
  test = await createTestApp({ app, handlers: [placeOrder, processOrder] });
});
afterEach(() => test.dispose());

it("retries a failed attempt after the backoff", async () => {
  test.failNext("orders.process");
  await test.send("orders", { orderId: "123" });
  await test.drain();
  expect(test.invocations({ handlerId: "orders.process" }).map(record => record.outcome)).toEqual(["failed", "ok"]);
});

it("processes a duplicated message once", async () => {
  const { messageId } = await test.send("orders", { orderId: "456" });
  await test.flush();
  test.duplicate("orders", messageId);
  await test.flush();
  expect(test.objects("receipts")).toHaveLength(1);
});
```

The [order pipeline example](../../examples/order-pipeline/README.md) has a complete suite.

## Pitfalls

- **Testing only one delivery.** Every queue and storage test should include a duplicate.
- **Wall-clock time and real timers.** Use `advance` and `drain` instead of sleeping.
- **Calling handler functions directly.** That skips input validation and middleware, hiding real failures.
- **Asserting on local ordering.** Do not assert on ordering that production does not guarantee.
- **Shared module state.** Module-level variables of the application survive between test apps in one process; keep state in resources.
- **Forgetting `dispose`.** A test app that is not disposed keeps the application bound, and the next `createTestApp` fails with `HOLQA_RUNTIME_ALREADY_BOUND`.

## Verification checklist

- [ ] Each consumer has a duplicate-delivery test and a permanent-failure test.
- [ ] Inputs that fail validation are tested at the trust boundary.
- [ ] Historical message shapes (previous `schemaVersion`s) are included as fixtures.
- [ ] Tests use the virtual clock and no real cloud resources or credentials.
- [ ] Test results reported are from an actual run, not assumed.
