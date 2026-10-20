# @holqa/testing

Testing utilities for Holqa applications.

> **Status:** Implemented, private and unpublished: `createTestApp` for deterministic integration tests on the local
> environment (with recording, replay and causal chains), and compile-time type assertions. `createTestApp` requires Bun; the type assertions do not.

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
| `duplicate(queueId, messageId)`, `duplicateEvent(bucketId, handlerId, eventId)`, `redrive(queueId, selection?)` | Duplicate delivery and redrive (all, one, or `{ messageId?, limit?, newOperation? }`). |
| `messages`, `deadLetters`, `events`, `objects`, `read`, `runs` | Inspect queues, buckets and schedules. |
| `logs`, `invocations(filter?)`, `trace(correlationId)` | Structured logs, and the finished invocations read from them (`InvocationRecord`: trigger, attempt, outcome, code, `causationId`, `rootId`, `depth`, `emitted`, `blocked`). |
| `lineage(invocationId)`, `operation(rootId)` | The publication chain that led to an invocation, and everything one root operation caused. |
| `recording({ sanitize?, handlerId?, rootId? })` | What every handler received (JSON input, trigger metadata, lineage) as a `holqa.recording/1` document, redacted like logs by default. HTTP requests are recorded as not replayable. |
| `replay(recording or invocations, { rootsOnly?, flush? })` | Runs recorded invocations again with their inputs and metadata, followed by the work they cause. A whole recording replays its roots only, so the application causes the rest again. |
| `chain(rootId)` | Steps through one root operation: its invocations depth first in causal order, with recorded inputs and the step that caused each. |
| `telemetry`, `flushTelemetry()` | Spans, metrics and exported log records recorded in memory with deterministic identifiers (`spans(filter?)`, `trace(traceId)`, `metrics()`, `metric(name, attributes?)`, `logs()`); flush before asserting. |
| `dispose()`, `[Symbol.asyncDispose]` | Stops the runtime, closes the state and removes the temporary directory. |

`telemetry` (`exporters`, `sampleRatio`, `messages`, `exportLogs`, `limits`), `logLevel` and `redact` pass through to the
runtime. `spanTree(spans)` arranges spans as `{ name, kind, status, children }` trees, so a test can assert a trace's
causal structure; `createMemoryTelemetry()` provides the same in-memory exporter for a runtime created directly. See
the [observability guide](../../docs/guides/observability.md#test-telemetry).

`events` sets the runtime's [event limits](../../docs/reference/runtime.md#event-lineage-and-limits) for the test.
`maxInvocations` (default 10 000) bounds the work a test runs: beyond it, `flush`, `advance` and `drain` throw
`HOLQA_SIMULATION_BUDGET_EXCEEDED` with the busiest handlers and the deepest chain instead of hanging on an event cycle.

Configuration comes from `env` (default `{}`), never from the test process's environment. Identifiers are sequential
by default (`id-1`, `id-2`, ...). One application instance can be bound to one runtime at a time, so dispose of a test
app before creating the next one for the same application. Module-level state of the application's modules is shared
by every test app in the process.

Replays are deterministic as far as handler code is: the virtual clock and sequential identifiers make the runtime side
repeatable, but external services, other databases and the real clock are reproduced only through explicit mocks or
fixtures. Sanitized recordings replace sensitive fields with `[REDACTED]`, which can change what a replay does.

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
