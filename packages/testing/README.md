# @holqa/testing

Testing utilities for Holqa applications.

> **Status:** Implemented, private and unpublished: `createTestApp` for deterministic integration tests on the local
> environment, and compile-time type assertions. `createTestApp` requires Bun; the type assertions do not.

## Integration tests with `createTestApp`

`createTestApp({ app, handlers })` starts the application on a `@holqa/runtime-bun` runtime with a `@holqa/local`
environment in its own temporary state directory and a virtual clock (`ManualClock`). Time only moves when the test
moves it, so retries, delays and schedules never make a test wait.

```ts
import { createTestApp } from "@holqa/testing";
import { expect, it } from "bun:test";

import app from "../app/infra";
import { placeOrder, processOrder } from "../app/src/orders.handler";

it("retries a failed order after its backoff", async () => {
  const test = await createTestApp({ app, handlers: [placeOrder, processOrder], startTime: "2026-10-18T09:30:00Z" });
  test.failNext("orders.process");                   // the next invocation throws before the handler runs
  await test.send("orders", { orderId: "123" });
  await test.drain();                                // moves virtual time through every retry
  expect(test.invocations({ handlerId: "orders.process" }).map(record => record.outcome)).toEqual(["failed", "ok"]);
  await test.dispose();
});
```

| Member | Purpose |
| --- | --- |
| `fetch(path or request, init?)` | Serves a request with the application's routes, procedures and local signed URLs. |
| `invoke(handlerId, input?, options?)` | Invokes a queue, object event or schedule handler once with generated metadata (`attempt`, `messageId`, `eventId`, `correlationId` can be set). HTTP handlers are called with `fetch`. |
| `send(queueId, message, { delaySeconds? })`, `put(bucketId, key, body, { contentType? })`, `trigger(scheduleId)` | Produce events, validated like a producer's. |
| `flush()` | Runs everything due now, including the follow-up work it causes, without moving the clock. |
| `advance(ms)` | Moves virtual time, stopping at every timer on the way (delays, retries, schedules) to run what became due. |
| `drain({ maxMs? })` | Moves time until no queue message or object event a handler receives is waiting. |
| `failNext(handlerId, { times?, error?, when? })` | Injects failures before the handler's own code runs. |
| `duplicate(queueId, messageId)`, `duplicateEvent(bucketId, handlerId, eventId)`, `redrive(queueId, messageId?)` | Duplicate delivery and redrive. |
| `messages`, `deadLetters`, `events`, `objects`, `read`, `runs` | Inspect queues, buckets and schedules. |
| `logs`, `invocations(filter?)`, `trace(correlationId)` | Structured logs, and the finished invocations read from them (`InvocationRecord`: trigger, attempt, outcome, code, `causationId`, `emitted`). |
| `dispose()`, `[Symbol.asyncDispose]` | Stops the runtime, closes the state and removes the temporary directory. |

Configuration comes from `env` (default `{}`), never from the test process's environment. Identifiers are sequential
by default (`id-1`, `id-2`, ...). One application instance can be bound to one runtime at a time, so dispose of a test
app before creating the next one for the same application. Module-level state of the application's modules is shared
by every test app in the process.

`createTestApp` loads `@holqa/local` (which uses `bun:sqlite`) only when it is called, so importing this package for
its type assertions works on any runtime.

## Type assertions

| Export | Purpose |
| --- | --- |
| `Equal`, `NotEqual`, `Expect`, `ExpectFalse` | Exact type equality and compile-time assertions. |
| `IsAny`, `IsNever`, `IsUnknown`, `Extends` | Type predicates. |
| `Accepts<Fn, Arg>` | Whether a handle operation accepts an argument type. |
| `TypeErrorMessage`, `HasTypeError` | Inspect the SDK's compile-time declaration checks. |
| `assertType<T>(value)` | Checks a value's type at compile time; does nothing at run time. |

```ts
import type { Accepts, Equal, Expect, ExpectFalse } from "@holqa/testing";
import type { QueueMessageInput } from "@holqa/sdk";

import { resources } from "./infra";

export type OrderContract = [
  Expect<Equal<QueueMessageInput<typeof resources.orders>, { orderId: string }>>,
  ExpectFalse<Accepts<typeof resources.orders.send, { id: string }>>
];
```

Assertions are checked by `tsc --noEmit`, not by the test runner.

See the [local development guide](../../docs/guides/local-development.md) and the
[order-pipeline example](../../examples/order-pipeline/README.md).

Boundaries: depends on `@holqa/core`, `@holqa/sdk`, `@holqa/local` and `@holqa/runtime-bun`.
