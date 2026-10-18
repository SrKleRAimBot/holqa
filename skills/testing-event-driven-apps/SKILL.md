---
name: testing-event-driven-apps
description: Tests Holqa handlers deterministically — HTTP routes, RPC procedures, queue consumers, storage events and schedules — including duplicate deliveries, retries, failures, dead-lettering and controlled time. Use when adding tests for a handler, reproducing an event-processing bug, or proving that a consumer is idempotent.
license: Apache-2.0
metadata:
  status: preview
---

# Testing event-driven applications

> **Preview — not yet available.** `@holqa/testing` exists in the Holqa repository (unpublished) but contains only compile-time type assertions (`Equal`, `Expect`, `Accepts`, `assertType`). The test harness below is **planned** and not implemented; code using it is illustrative. Today you can drive a whole application deterministically with `@holqa/local` (also unpublished): a `ManualClock`, real delivery through `@holqa/runtime-bun`, and inspection of messages, events and schedule runs.

## When to use

- Writing tests for a new handler.
- Proving idempotency of a consumer or storage event handler.
- Reproducing a retry, ordering or dead-letter bug.

## Works today

- Extract business logic into plain functions and test them with your normal test runner (for example `bun test`). This remains good practice once the harness exists.
- Test your own validation schemas directly (`schema.safeParse(...)`) with valid, invalid and historical payloads.
- Run the application on `createLocalEnvironment({ app, directory, clock: new ManualClock() })` with `createRuntime({ ..., binding: env.binding })`: send messages or write objects, `await env.settle()`, move time with `clock.advance(ms)` (or `clock.jump(ms)` to simulate a late scheduler), and assert on `env.queues.messages(...)`, `env.queues.deadLetters(...)`, `env.storage.events(...)` and `env.scheduler.runs(...)`. Simulate duplicates with `env.queues.duplicate(...)` and `env.storage.duplicateEvent(...)`. [`examples/document-processing`](../../examples/document-processing/README.md) shows retries and dead-lettering this way.

## Planned workflow

1. **Create a test app** from `infra.ts` with the planned harness. It uses the local runtime with in-memory or temporary resources and no cloud credentials.
2. **Control time and randomness** so schedules and retries are deterministic.
3. **Trigger events** through typed helpers rather than calling handlers directly, so validation and middleware run.
4. **Assert on outcomes** (database state, sent messages, stored objects, logs), not on internal calls.
5. **Cover the failure matrix:** duplicate delivery, concurrent duplicates, handler throws then succeeds, permanent failure to dead-letter, malformed input, old schema versions.

```ts
// tests/orders/process-order.test.ts — illustrative, planned API
import { createTestApp } from "@holqa/testing";
import { describe, expect, it } from "bun:test";
import app from "../../infra";

describe("orders.process", () => {
  it("processes a duplicated message once", async () => {
    await using t = await createTestApp(app);
    const message = { orderId: "4b1e…", priority: "normal" as const };

    await t.queue("order-processing").deliver(message);
    await t.queue("order-processing").deliver(message);   // simulated redelivery

    expect(await countProcessed(t.env.DATABASE_URL, message.orderId)).toBe(1);
  });

  it("dead-letters after maxAttempts", async () => {
    await using t = await createTestApp(app, { failHandler: "orders.process" });
    await t.queue("order-processing").deliver({ orderId: "bad", priority: "normal" });
    await t.runUntilIdle();

    expect(t.queue("order-processing").deadLetters()).toHaveLength(1);
  });

  it("runs the cleanup at a fixed time", async () => {
    await using t = await createTestApp(app, { now: new Date("2026-01-01T02:00:00Z") });
    await t.schedule("daily-cleanup").trigger();
  });
});
```

`countProcessed` stands for your own query helper.

## Pitfalls

- **Testing only one delivery.** Every queue and storage test should include a duplicate.
- **Wall-clock time and real timers.** They make retries and schedules flaky; use controlled time.
- **Calling handler functions directly.** That skips input validation and middleware, hiding real failures.
- **Assuming local emulation order.** Do not assert on ordering that production does not guarantee.
- **Shared state between tests.** Use a fresh test app and database schema per test.
- **Mocking the queue away.** Then idempotency and retry behavior are never exercised.

## Verification checklist

- [ ] Each consumer has a duplicate-delivery test and a permanent-failure test.
- [ ] Inputs that fail validation are tested at the trust boundary.
- [ ] Historical message shapes (previous `schemaVersion`s) are included as fixtures.
- [ ] Tests use controlled time and no real cloud resources or credentials.
- [ ] Test results reported are from an actual run, not assumed.
