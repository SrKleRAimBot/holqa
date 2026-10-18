# @holqa/runtime-bun

> **Status:** Implemented (invocation dispatcher, lifecycle, HTTP routes, RPC procedures, `Bun.serve` adapter, queue, object event and schedule delivery). Private; not published. Worker or process isolation is planned.

Runs a Holqa application on Bun. Every invocation, whatever triggered it, goes through one dispatcher that assigns
invocation and correlation identifiers, applies time limits, cancellation and concurrency limits, normalizes errors
and writes structured logs. HTTP routes, RPC procedures, queue consumers, object event handlers and schedule handlers
are transports built on it. Background deliveries come from a binding's `sources`; the runtime applies retries,
backoff, dead-lettering, consumer concurrency and overlap policies the same way for every binding.

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
| `loadCompiledApplication({ root, buildDir? })` | Load an application from `holqa build --manifest` output and check it still matches the code. |
| `createEnvironmentBinding(app, env)` | The default binding: HTTP APIs and configuration validated from environment variables. It delivers nothing; use `@holqa/local` for queues, buckets and schedules. |
| `jsonLineSink`, `silentSink` | Log sinks. |

See the [runtime reference](../../docs/reference/runtime.md) for the execution lifecycle, HTTP contracts, RPC
semantics, middleware ordering, and queue, object event and schedule delivery, and [ADR 0023](../../docs/architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md)
for the design (delivery: [ADR 0024](../../docs/architecture/decisions/0024-event-delivery-sources-and-local-drivers.md)).

Boundaries: depends on `@holqa/core` only. Its tests use hand-built descriptors; end-to-end tests with the SDK live in [`examples/http-api`](../../examples/http-api/README.md) and [`examples/document-processing`](../../examples/document-processing/README.md). Bun-specific APIs
(`Bun.serve`, `Bun.file`) are confined to `serve` and `loadCompiledApplication`; `createRuntime` uses Web-standard
APIs only.
