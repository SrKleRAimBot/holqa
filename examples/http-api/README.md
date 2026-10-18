# HTTP API example

> **Status:** **Implemented.** Executed by `pnpm test` and `pnpm check` (and therefore CI).

A private workspace package: a small shop written with `@holqa/sdk` and Zod, compiled by the **built** `holqa` binary
and served by `@holqa/runtime-bun` over a real loopback port. It is the acceptance test of the runtime milestone. See
the [runtime reference](../../docs/reference/runtime.md).

| File | What it shows |
| --- | --- |
| [`app/infra.ts`](app/infra.ts) | One `http.api`, a configuration variable, and application middleware whose context every handler sees. |
| [`app/src/middleware.ts`](app/src/middleware.ts) | `requestContext` (adds `requestId`, sets `server-timing`) and `authenticate` (rejects with `401`, adds `user`). Demo tokens only. |
| [`app/src/orders.handler.ts`](app/src/orders.handler.ts) | Routes with path, query and body schemas, status-specific responses, route middleware, `reply` with headers, and a streamed `text/event-stream` response. |
| [`app/src/rpc.handler.ts`](app/src/rpc.handler.ts) | A query (`GET` or `POST`) and an authenticated mutation (`POST`). |
| [`app/src/store.ts`](app/src/store.ts) | An in-memory store declared with `scoped`, created once per runtime. Not durable. |
| [`app/server.ts`](app/server.ts) | Loads the build output, serves it and stops gracefully on `SIGINT`/`SIGTERM`. |

| Test ([`tests/http-api.test.ts`](tests/http-api.test.ts)) | Asserts |
| --- | --- |
| Compiled execution | `holqa build --manifest` succeeds, `loadCompiledApplication` loads the output, and `serve` answers real HTTP requests with typed, validated responses. |
| Validation | Invalid bodies, parameters and queries answer `400 HOLQA_INPUT_INVALID` with per-field issues and the invocation identifier; a non-JSON body answers `415`. |
| Routing | Unknown paths answer `404`, wrong methods `405` with `allow`, unauthenticated requests `401` with `www-authenticate`. |
| Concurrency | Twelve overlapping requests that finish in reverse order each keep their own parameters and correlation identifier. |
| Streaming | The event stream arrives intact. |
| RPC | Queries and mutations share the routes' middleware and validation and answer `holqa.rpc/1` envelopes; unsupported protocol versions are rejected. |
| Logs | Invocations are logged with invocation and correlation identifiers. |
| Types | Middleware context and client contracts are inferred; using `context.user` without `authenticate` is a compile error. |

```bash
pnpm turbo run test --filter=@holqa/example-http-api
# or run the server (after `pnpm build`): builds the manifest, then serves on PORT (default 3000)
pnpm --filter @holqa/example-http-api start
curl -X POST localhost:3000/api/orders -H 'authorization: Bearer token-ada' -H 'content-type: application/json' -d '{"sku":"tea","quantity":1}'
curl localhost:3000/api/rpc/orders.count
```
