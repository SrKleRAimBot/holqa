# @holqa/runtime-bun

> **Status:** Implemented (invocation dispatcher, lifecycle, HTTP routes, RPC procedures, `Bun.serve` adapter). Private; not published. Queue, storage and schedule delivery are planned.

Runs a Holqa application on Bun. Every invocation, whatever triggered it, goes through one dispatcher that assigns
invocation and correlation identifiers, applies time limits, cancellation and concurrency limits, normalizes errors
and writes structured logs. HTTP routes and RPC procedures are the first transports built on it.

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
| `createEnvironmentBinding(app, env)` | The default binding: HTTP APIs and configuration validated from environment variables. |
| `jsonLineSink`, `silentSink` | Log sinks. |

See the [runtime reference](../../docs/reference/runtime.md) for the execution lifecycle, HTTP contracts, RPC
semantics and middleware ordering, and [ADR 0023](../../docs/architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md)
for the design.

Boundaries: depends on `@holqa/core` only. Its tests use hand-built descriptors; end-to-end tests with the SDK live in [`examples/http-api`](../../examples/http-api/README.md). Bun-specific APIs
(`Bun.serve`, `Bun.file`) are confined to `serve` and `loadCompiledApplication`; `createRuntime` uses Web-standard
APIs only.
