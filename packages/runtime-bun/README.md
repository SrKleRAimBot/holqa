# @holqa/runtime-bun

> **Status:** Implemented (invocation dispatcher, lifecycle, HTTP routes, RPC procedures, `Bun.serve` adapter, queue, object event and schedule delivery, event lineage and limits). Private; not published. `holqa dev` reloads by restarting one process per generation ([ADR 0025](../../docs/architecture/decisions/0025-dev-supervisor-and-process-generations.md)); worker isolation is planned.

Runs a Holqa application on Bun. Every invocation, whatever triggered it, goes through one dispatcher that assigns
invocation and correlation identifiers, applies time limits, cancellation and concurrency limits, normalizes errors
and writes structured logs with trace identifiers (`correlationId`, `causationId`), the trigger, the delivery attempt and
what the invocation emitted. Messages a handler sends and objects it writes carry its trace, so the invocations they
trigger join the same trace. HTTP routes, RPC procedures, queue consumers, object event handlers and schedule handlers
are transports built on it. Background deliveries come from a binding's `sources`; the runtime applies retries,
backoff, dead-lettering, consumer concurrency and overlap policies the same way for every binding.

Every invocation also has an event lineage (root operation, cause, depth). Before handler code's send, write or
delete reaches the binding, the runtime checks it against the event limits (`events` option: `maxDepth`, default 16;
`maxPublications`, default 1000; `maxEventAgeMs`; `maxEventsPerOperation`, which needs a binding with atomic
operation budgets), and deliveries past a limit end terminally instead of being retried. See
[event lineage and limits](../../docs/reference/runtime.md#event-lineage-and-limits).

```ts
import { createRuntime, loadCompiledApplication, serve, stopOnSignals } from "@holqa/runtime-bun";

// Output of `holqa build --manifest` next to infra.ts.
const runtime = createRuntime(await loadCompiledApplication({ root: import.meta.dir }));
const server = await serve(runtime, { port: 3000 });
stopOnSignals(server);
```

| Export | Purpose |
| --- | --- |
| `createRuntime(options)` | One application execution context: validates handlers and routes, then `start`, `invoke`, `fetch`, `stop`, `stats`. |
| `serve(runtime, options)`, `stopOnSignals(server)` | Serve a runtime with `Bun.serve`; stop gracefully on `SIGINT`/`SIGTERM`. |
| `loadCompiledApplication({ root, buildDir? })` | Load an application from `holqa build --manifest` output and check it still matches the code; returns `handlerSources` for failure logs. |
| `createEnvironmentBinding(app, env)` | The default binding: HTTP APIs and configuration validated from environment variables. It delivers nothing; use `@holqa/local` for queues, buckets and schedules. |
| `jsonLineSink`, `silentSink` | Log sinks. |
| `EmittedEvent` | What an invocation emitted (`InvocationOutcome.emitted`): sent messages and changed objects. |

See the [runtime reference](../../docs/reference/runtime.md) for the execution lifecycle, HTTP contracts, RPC
semantics, middleware ordering, and queue, object event and schedule delivery, and [ADR 0023](../../docs/architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md)
for the design (delivery: [ADR 0024](../../docs/architecture/decisions/0024-event-delivery-sources-and-local-drivers.md)).

Boundaries: depends on `@holqa/core` only. Its tests use hand-built descriptors; end-to-end tests with the SDK live in [`examples/http-api`](../../examples/http-api/README.md) and [`examples/document-processing`](../../examples/document-processing/README.md). Bun-specific APIs
(`Bun.serve`, `Bun.file`) are confined to `serve` and `loadCompiledApplication`; `createRuntime` uses Web-standard
APIs plus `AsyncLocalStorage` from `node:async_hooks`, which Bun and Node both provide, to attribute resource
operations to invocations.
