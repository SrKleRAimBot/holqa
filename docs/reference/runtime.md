# Runtime

> **Status:** **Implemented** in `@holqa/runtime-bun` (dispatcher, lifecycle, HTTP routes, RPC procedures, `Bun.serve` adapter), `@holqa/sdk` (`route`, `procedure`, `reply`, `middleware`, `scoped`) and `@holqa/core` (wire contracts). Queue, storage and schedule delivery, worker isolation and reload are **Planned**. All packages are private and unpublished.

This page specifies how a Holqa application executes: the invocation lifecycle shared by every trigger, the HTTP route contract, the `holqa.rpc/1` protocol, and middleware ordering. The design is recorded in [ADR 0023](../architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md).

## Layers

| Package | Responsibility |
| --- | --- |
| `@holqa/core` | Runtime-neutral contracts: the `http.procedure` trigger kind, `HttpInvocationInput`, `HttpRejectedError`, `HttpErrorBody`, the `holqa.rpc/1` envelope types and constants, `ApplicationScope` and `ScopedDefinition`. |
| `@holqa/sdk` | Declarations: `api.route`, `api.procedure`, `reply`, `middleware`, `scoped`, application and API middleware. Each registration's `invoke` validates the request, runs the middleware chain and the handler, and checks the response. Runtime-neutral. |
| `@holqa/runtime-bun` | Execution: `createRuntime` (dispatcher, lifecycle, router, CORS, error responses, logs), `loadCompiledApplication`, and `serve` (`Bun.serve`). Depends on `@holqa/core` only and reads descriptors; it never imports the SDK. |

## Running an application

```ts
import { createRuntime, loadCompiledApplication, serve, stopOnSignals } from "@holqa/runtime-bun";

// Reads the output of `holqa build --manifest` (default: <root>/.holqa/build).
const runtime = createRuntime(await loadCompiledApplication({ root: import.meta.dir }));
const server = await serve(runtime, { port: 3000 }); // starts the runtime first
stopOnSignals(server); // graceful stop on SIGINT and SIGTERM
```

`createRuntime({ app, handlers })` also accepts registrations directly, for tests and embedding; `runtime.fetch(request)` serves a Fetch `Request` without a server. The [`http-api` example](../../examples/http-api/README.md) is a complete application compiled by the CLI and served this way.

### `createRuntime` options

| Option | Default | Meaning |
| --- | --- | --- |
| `app` | required | The application: the default export of `infra.ts`. |
| `handlers` | required | Handler registrations. The same registration listed twice counts once. |
| `binding` | environment binding | The data-plane binding. The default serves `http.api` only and reads configuration from `env`; it advertises no queue, bucket or schedule capability, so such applications fail to start with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`. |
| `env` | `process.env` | Environment variables for the default binding. |
| `limits.concurrency` | `256` | Concurrent invocations across all handlers. |
| `limits.queue` | `1024` | Invocations waiting for a slot; beyond it, `HOLQA_RUNTIME_OVERLOADED`. |
| `limits.timeoutMs` | `30000` | Time limit per invocation, including waiting for a slot. `Infinity` means none; longer finite values are capped at 2^31 − 1 ms. |
| `http.cors` | none | [CORS](#cors) policy. |
| `http.trustCorrelationHeader` | `true` | Adopt a caller's `x-correlation-id` (at most 128 letters, digits, `_`, `.`, `:`, `-`). Set `false` for servers exposed to untrusted callers, so logs never contain caller-chosen identifiers. |
| `manualTriggers` | `false` | Accept queue, object-created and schedule handlers, which this runtime cannot deliver yet, to run them through `runtime.invoke` only. Without it they fail `createRuntime` with `HOLQA_RUNTIME_START_FAILED`. |
| `log` | JSON lines on standard output | A `LogSink`; `silentSink` discards. |
| `createId`, `now`, `clock` | `crypto.randomUUID`, `performance.now`, `new Date()` | Injectable for deterministic tests. |

`createRuntime` is synchronous and side-effect free. It reports every problem at once in one `HolqaError`: a value that is not an application (`HOLQA_APP_INVALID`), a non-handler (`HOLQA_DECLARATION_INVALID`), two registrations with one identifier (`HOLQA_HANDLER_ID_DUPLICATE`), a trigger on an undeclared resource (`HOLQA_RESOURCE_NOT_FOUND`) or a resource of another kind (`HOLQA_TRIGGER_INVALID`), two handlers serving the same method and path shape across all APIs (`HOLQA_ROUTE_CONFLICT`, the same rule the compiler applies), handlers whose trigger has no transport (`HOLQA_RUNTIME_START_FAILED`, unless `manualTriggers`), and invalid limits or CORS settings (`HOLQA_RUNTIME_START_FAILED`). These checks repeat the compiler's for registrations that were never compiled; the route rule is the shared `httpRouteKeys` function from `@holqa/core`.

## Execution lifecycle

| State | Entered by | Accepts invocations |
| --- | --- | --- |
| `idle` | `createRuntime` | No (`HOLQA_RUNTIME_NOT_RUNNING`) |
| `starting` | `start()` | No |
| `running` | `start()` succeeded | Yes |
| `stopping` | `stop()` | No; in-flight invocations continue |
| `stopped` | `stop()` finished, or `start()` failed | No |

`start()` runs once. It creates the binding (validating every configuration entry; see [configuration](#configuration)) and installs it with `bindApp`. A failure throws `HOLQA_RUNTIME_START_FAILED` followed by its causes and leaves the runtime `stopped`; create a new runtime to retry. Calling `stop()` while `start()` is still running makes the start fail (`HOLQA_RUNTIME_NOT_RUNNING`) and never installs the binding.

`stop({ graceMs = 10000, forceMs = 1000 })` is idempotent; concurrent calls share one stop. It:

1. refuses new invocations;
2. waits up to `graceMs` for admitted invocations to finish, including those still waiting for a slot; scoped values stay usable meanwhile;
3. aborts the remaining ones (their callers receive `HOLQA_INVOCATION_CANCELLED`) and waits up to `forceMs` for handler code that ignores its signal, logging a warning if some is still running;
4. aborts the application scope's `signal` and disposes of scoped values in reverse creation order (a failing `dispose` is logged, and the others still run);
5. removes the binding.

`serve(...).stop()` stops the runtime first, while the server keeps listening and answers new requests with `503`, then waits up to `forceMs` for responses that are still being written, then closes every connection.

## Invocations

Every trigger goes through one dispatcher. HTTP requests (`runtime.fetch`) and direct invocations (`runtime.invoke`) share its limits, lifecycle, error normalization and logging; only the input and the presentation of the outcome differ.

```ts
const outcome = await runtime.invoke({
  handlerId: "nightly.report",                   // stable handler identifier
  input: undefined,                              // untrusted; the handler validates it
  metadata: { scheduledTime: "2026-10-18T03:00:00Z" }, // trusted trigger metadata
  signal: controller.signal,                     // optional caller cancellation
  correlationId: "batch-7",                      // optional; defaults to the invocation id
  timeoutMs: 5000                                // optional; overrides limits.timeoutMs
});
if (!outcome.ok)
  console.error(outcome.failure.code, outcome.failure.message);
```

| Rule | Behaviour |
| --- | --- |
| Identity | Every invocation gets a unique `invocationId`; `correlationId` groups related invocations and defaults to it. Both are in the handler's context, every log entry and the `x-correlation-id` response header. |
| Outcome | `invoke` never rejects. It resolves to `{ ok: true, value }` or `{ ok: false, failure }`, both with `invocationId`, `correlationId`, `handlerId` and `durationMs`. |
| Concurrency | A FIFO gate of `limits.concurrency` slots with a wait queue of `limits.queue`. A queue consumer's own `concurrency` is a second gate, acquired first, so invocations waiting for it hold no environment-wide slot. A full queue answers `HOLQA_RUNTIME_OVERLOADED` at once. |
| Metadata | Trusted, but checked against the trigger kind: a queue consumer needs `{ attempt, messageId }`, a schedule handler `{ scheduledTime }`; otherwise `HOLQA_INPUT_INVALID`. |
| Time limit | Measured from dispatch, including waiting. When it passes, the invocation's `signal` aborts and the caller receives `HOLQA_INVOCATION_TIMEOUT`. |
| Cancellation | When the caller's signal aborts (an HTTP client disconnecting aborts `request.signal`), the invocation's signal aborts and the caller receives `HOLQA_INVOCATION_CANCELLED`. An invocation aborted before its handler starts never starts it. |
| Orphans | JavaScript cannot stop a running function. A handler that ignores its signal keeps running as an orphan and **keeps its concurrency slot** until it finishes, so cancellation never exceeds the limit. `stats().orphaned` counts them. Handlers must honour `signal`. |
| Errors | Thrown values are normalized as described under [error responses](#error-responses). Original errors are logged, never returned. |

### Application scope and invocation context

The runtime is one **application execution context**: one bound application instance, one binding, and one `ApplicationScope`. Each **invocation** gets its own context: `invocationId`, `correlationId`, `signal`, `metadata`, a logger bound to its identifiers, and the shared `scope`.

```ts
import { scoped } from "@holqa/sdk";

export const database = scoped({
  name: "database",
  create: () => createPool(env.DATABASE_URL), // once per runtime, on first use
  dispose: pool => pool.end() // when the runtime stops
});

// In a handler or middleware:
const pool = await scope.use(database);
```

Concurrent first uses share one creation, a failed creation is not cached, and `use` fails with `HOLQA_RUNTIME_NOT_RUNNING` once in-flight work has drained during a stop; a value whose creation finishes after that is disposed of at once. Two runtimes never share scoped values. Invocation state belongs in the handler's locals or the middleware context, which is built per invocation and frozen; module-level variables are shared by every invocation of the process and are not part of this contract.

An application instance can be bound to one runtime at a time: starting a second runtime on the same instance fails with `HOLQA_RUNTIME_ALREADY_BOUND`. Running applications in separate workers or processes, each with its own instance, is **Planned** ([ADR 0015](../architecture/decisions/0015-runtime-generations-and-reload.md)); the runtime API takes everything it needs as explicit options so that a deployment adapter can create one runtime per isolated environment.

### Configuration

The default binding validates every configuration entry at `start()`: the environment variable, or the declared default when it is unset, must satisfy the entry's schema (values are strings; use coercing schemas such as `z.coerce.number()`). Problems are reported together as `HOLQA_CONFIG_INVALID`; a secret is reported by name only, without its value or the schema's message.

### Logs

Entries are JSON objects with `level`, `time` and `message`, then context fields (`application`, `handlerId`, `invocationId`, `correlationId`, and `method` and `path` for HTTP), then the fields a handler passes to `log.info/warn/error`. Fields cannot replace `level`, `time` or `message`. The runtime writes `runtime started`, `invocation completed` (`outcome`, `durationMs`), `invocation failed` (`code`, `durationMs`, and `error` with name, message, stack and diagnostics; level `error` for server errors), `request rejected` (unmatched requests), and `runtime stopped`. Request and response bodies are never logged.

## HTTP routes

```ts
export const getOrder = resources.api.route({
  id: "orders.get",
  method: "GET",
  path: "/orders/:orderId",
  params: z.object({ orderId: z.string() }),
  responses: { 200: order, 404: z.object({ message: z.string() }) },
  handler: async ({ params, scope, reply }) => {
    const found = (await scope.use(orderStore)).find(params.orderId);
    return found === undefined ? reply(404, { message: "Not found." }) : reply(200, found);
  }
});
```

| Declaration | Rule |
| --- | --- |
| `method` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. `GET` and `DELETE` must not declare `body`. |
| `path` | Relative to the API's `basePath`; `:name` segments are parameters, each at most once. |
| `params` | Without a schema, a record of the template's parameters as strings. With one, it must declare exactly the template's parameters (compile-time check). |
| `query` | Validated from `{ name: string }`, or `{ name: string[] }` when a name repeats. |
| `headers` | Validated from a record of lowercase header names; repeated headers are joined with `, `. |
| `body` | JSON only. A non-empty body must have `content-type: application/json` (or `application/*+json`), otherwise `415`. An empty body is validated as `undefined`. Without a `body` schema the body is not read, so `request.body` can be streamed. |
| `responses` | At least one status (100–599), each with a schema. |

The handler receives `params`, `query`, `headers` and `body` (validated output types), `context` (from middleware), `request`, `url`, `invocationId`, `correlationId`, `signal`, `log`, `scope` and `reply`.

| Handler returns | Response |
| --- | --- |
| `reply(status, body, headers?)` | `status` must be declared. The body (the schema's input type) is validated with that status's schema and its **output** is sent as an exact JSON copy, as the compiler describes response roles; an output without a JSON form fails. `content-type: application/json; charset=utf-8` unless set. `undefined` sends no body; `101`, `204`, `205` and `304` must not have one. |
| A `Response` | Passed through unread, for streaming and non-JSON bodies. Its status must be declared, but **its body is not validated**. |
| Anything else, an undeclared status or an invalid body | `500 HOLQA_RESPONSE_INVALID`. |

### Routing

| Rule | Behaviour |
| --- | --- |
| Paths | `basePath` and route path are joined. Matching uses percent-decoded segments; a trailing `/` is ignored; invalid percent-encoding answers `400 HOLQA_INPUT_INVALID`. |
| Precedence | At the first position where two templates differ, a static segment wins over a parameter (`/orders/new` before `/orders/:id`). If the more specific route lacks the method, a less specific one that has it is used. |
| Conflicts | Two handlers with the same method and shape (parameter names ignored) fail `createRuntime`, also across APIs with the same base path. |
| `HEAD` | Served by the `GET` route without a body. |
| `OPTIONS` | `204` with `allow`, or a CORS preflight answer. |
| CORS caching | With a list or predicate of origins, every response carries `vary: origin`, also when no CORS headers are sent. |
| Unmatched | `404 HOLQA_HTTP_ROUTE_NOT_FOUND`, or `405 HOLQA_HTTP_METHOD_NOT_ALLOWED` with `allow`. |

### CORS

`http.cors` is `{ origins, allowHeaders?, exposeHeaders?, credentials?, maxAgeSeconds? }`, where `origins` is `"*"`, a list of exact origins or a predicate. Preflights (`OPTIONS` with `origin` and `access-control-request-method`) for allowed origins answer `204` with the path's methods; other origins get no CORS headers. Every response to an allowed origin, including errors, carries `access-control-allow-origin` (and `vary: origin` unless `*`), and exposes `x-correlation-id`. `credentials: true` with `origins: "*"` is rejected. Declaring CORS on an `http.api`, so that it is part of the manifest, is **Proposed**.

### Error responses

Route errors are JSON `{ "error": { "code", "message", "invocationId"?, "issues"? } }` (`HttpErrorBody`); procedure errors use the [RPC failure envelope](#responses). Messages are safe to show: handler error messages, stack traces, rejected input and secrets are never included.

| Status | Code | Cause |
| --- | --- | --- |
| `400` | `HOLQA_INPUT_INVALID` | Path parameters, query, headers, body or RPC input fail their schema (with `issues`), or the path is malformed. |
| `400` | `HOLQA_PAYLOAD_MALFORMED` | The body or RPC input is not JSON, or an RPC envelope is malformed. |
| `400` | `HOLQA_RPC_VERSION_UNSUPPORTED` | `holqa-rpc-version` is not `1`. |
| `404` | `HOLQA_HTTP_ROUTE_NOT_FOUND` | No route or procedure serves the path. |
| `405` | `HOLQA_HTTP_METHOD_NOT_ALLOWED` | The path exists with other methods. |
| `415` | `HOLQA_HTTP_MEDIA_TYPE_UNSUPPORTED` | The body is not JSON. |
| `4xx`/`5xx` | `HOLQA_HTTP_REJECTED`, or the cause's code | An `HttpRejectedError` from middleware or the handler. |
| `500` | `HOLQA_RESPONSE_INVALID` | The response breaks the declared contract. |
| `500` | `HOLQA_HANDLER_FAILED` | Any other thrown error, including Holqa errors raised by handler code. |
| `503` | `HOLQA_RUNTIME_OVERLOADED` (with `retry-after`), `HOLQA_RUNTIME_NOT_RUNNING`, `HOLQA_INVOCATION_CANCELLED` | Capacity, lifecycle or cancellation. |
| `504` | `HOLQA_INVOCATION_TIMEOUT` | The time limit passed. |

The SDK marks problems found while reading the request as the caller's fault by wrapping them in `HttpRejectedError` (keeping their code). A `HOLQA_INPUT_INVALID` raised later by handler code, for example an invalid queue `send`, is a server error and answers `500 HOLQA_HANDLER_FAILED`. To reject a request deliberately, throw `new HttpRejectedError(status, message, { headers?, cause? })`; header names and values are validated. With a Holqa error as `cause`, the cause's code, message and issues are sent to the caller instead, so pass only causes whose messages are safe to show. A response that cannot be built still answers a generic `500`; `runtime.fetch` never rejects.

## Middleware

```ts
import { HttpRejectedError } from "@holqa/core";
import { middleware } from "@holqa/sdk";

export const authenticate = middleware({
  name: "authenticate",
  handle: async ({ request, next }) => {
    const user = await verify(request.headers.get("authorization"));
    if (user === undefined)
      throw new HttpRejectedError(401, "Sign in to continue.");
    return next({ user }); // adds `user` to the typed context
  }
});

// Requires context from earlier middleware; attaching it before them is a compile error.
export const adminOnly = middleware.requires<{ readonly user: User }>()({
  name: "admin-only",
  handle: ({ context, next }) => {
    if (!context.user.roles.includes("admin"))
      throw new HttpRejectedError(403, "Administrators only.");
    return next();
  }
});
```

| Scope | Declared in | Runs |
| --- | --- | --- |
| Application | `defineApp({ middleware })` | First, for every route and procedure of every API. |
| API | `http.api({ middleware })` | Next, for the API's routes and procedures. |
| Route or procedure | `route({ middleware })`, `procedure({ middleware })` | Last, just before validation and the handler. |

Within a scope, middleware runs in list order. Each runs around the rest of the chain:

| Concern | Rule |
| --- | --- |
| Order | `app[0] → … → api[0] → … → route[0] → … → validation → handler`, then back out in reverse. |
| Context | `next(extension)` adds properties for later middleware and the handler; a later property replaces an earlier one with the same name. The handler's `context` is typed from the chain, in which the added context is inferred from the value a middleware returns: return `next`'s result or a copy of it (`{ ...result, response }`). Middleware that requires context must be listed inline (or `as const`) so its order is checked. Routes registered through `app.resources` also see application middleware's context; registering on the original handle omits it from the type (never adds it). API middleware cannot require application context at compile time. |
| Short circuit | Return a `Response` without calling `next`, or throw an `HttpRejectedError`. Short-circuit responses are not checked against the route's `responses`. For procedures, prefer throwing so callers get an RPC envelope. |
| Contract | The route's response contract is checked before middleware sees the response. A middleware that replaces the response (or its status) after `next` is not checked again; it is responsible for keeping the contract. |
| Response | `next()` resolves to `{ response }`; return it, return it with another `response`, or return a new `Response`. |
| Errors | Errors from later middleware, validation or the handler propagate through `await next()`; middleware may catch and translate them. |
| Cleanup | Use `try`/`finally` around `await next()`. A streamed body is still being sent after `finally` runs. |
| Request body | Middleware sees the unread request; the body is read after the chain, by the route's `body` schema or the handler. |
| Misuse | Calling `next` twice, passing a non-object, or returning anything other than a `Response` or `next`'s result fails the invocation. |

Authentication is application code built on middleware; Holqa provides no identity service.

## RPC procedures

```ts
export const cancelOrder = resources.api.procedure({
  id: "orders.cancel",
  operation: "mutation", // or "query"
  middleware: [authenticate],
  input: z.object({ orderId: z.string() }), // optional
  output: order.nullable(),
  handler: async ({ input, scope }) => (await scope.use(orderStore)).cancel(input.orderId) ?? null
});
```

A procedure is an HTTP route with a conventional path and envelope, executed by the same dispatcher, middleware chain, validation and error handling. Its identifier is its stable procedure ID. The compiler records it as an `http.procedure` trigger with `{ operation }` and `input`/`output` schemas.

### Protocol `holqa.rpc/1`

Holqa's own versioned protocol. It is **not** JSON-RPC 2.0 and is not compatible with it.

| Aspect | Rule |
| --- | --- |
| Path | `<basePath>/rpc/<procedure id>`, for example `/api/rpc/orders.cancel`. |
| Methods | `POST` for queries and mutations. `GET` for queries only (`405` for mutations). |
| `POST` body | `{ "input": <value> }` with `content-type: application/json`; the only allowed key is `input`. An empty body, or an omitted `input`, means no input. |
| `GET` input | The `input` query parameter holds the JSON-encoded input (`?input=%7B%22orderId%22%3A%221%22%7D`); absent means no input; at most once. |
| Input | Sent in the input schema's input form and validated before the handler runs. A procedure without an input schema rejects any input. |
| Version | Optional request header `holqa-rpc-version: 1`. Any other value is rejected with `HOLQA_RPC_VERSION_UNSUPPORTED`. Every response carries `format: "holqa.rpc/1"`. |
| Queries | Must be safe to repeat; clients may cache them. |

### Responses

| Outcome | Status | Body |
| --- | --- | --- |
| Success | `200` | `{ "format": "holqa.rpc/1", "ok": true, "output": <value> }`. `output` is the validated output in the output schema's **output** form (like a route response); it is omitted when that output is `undefined`. |
| Failure | as in [error responses](#error-responses) | `{ "format": "holqa.rpc/1", "ok": false, "error": { "code", "message", "invocationId"?, "issues"? } }`. Unknown procedures and method mismatches under `<basePath>/rpc/` also use this envelope. |

Middleware that returns its own `Response` bypasses the envelope. Typed clients for procedures are **Planned** (`@holqa/client`); the envelope types (`RpcResponseEnvelope`, `RpcRequestEnvelope`) are exported by `@holqa/core`.

## Compiled applications

`loadCompiledApplication({ root, buildDir? })` reads `manifest.json` and `entrypoints.json` written by `holqa build --manifest`, imports the application module and each handler module, and returns `{ app, handlers, manifestFingerprint }` for `createRuntime`. It fails with `HOLQA_APP_NOT_FOUND` without build output, `HOLQA_MANIFEST_INVALID` for malformed output (including module paths outside the root), `HOLQA_MANIFEST_VERSION_UNSUPPORTED` for another manifest version, `HOLQA_APP_INVALID` when the application module's default export is not an application, `HOLQA_MODULE_EVALUATION_FAILED` when a module throws, and `HOLQA_BUILD_STALE` when the entry point map belongs to another manifest or the application name, resources (kind, identifier, settings, requirements), configuration entries, handler exports or triggers changed since the build. Schema changes and handler modules added after the build are not detected; rebuild after changing either.

Loading evaluates the application's code in the current process with its permissions. It is not a sandbox; load only build output you trust.

## Bun and other runtimes

`createRuntime` and `runtime.fetch` use Web-standard APIs (`Request`, `Response`, `URL`, `AbortController`, `crypto.randomUUID`, timers) plus the global `process.env` as the default environment. `serve` uses `Bun.serve`, and `loadCompiledApplication` uses `Bun.file`, `node:path` and `node:url`; both need Bun 1.3.13 or later. `serve` binds `127.0.0.1` by default, limits request bodies to 1 MiB (Bun answers larger ones with `413`), and does not use `stop(false)`, which on Bun 1.3.13 leaves keep-alive connections open.

## Not implemented

| Capability | Status |
| --- | --- |
| Queue, bucket and schedule delivery (consumers run only through `runtime.invoke`) | Planned (`@holqa/local`) |
| Worker or process isolation per application, reload, `holqa dev` | Planned |
| Middleware for background triggers | Planned |
| CORS and body limits declared in the application | Proposed |
| OpenAPI documents, generated clients | Planned |

## Related

- [ADR 0023](../architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md)
- [Triggers and execution](../concepts/triggers-and-execution.md)
- [Packages](packages.md)
- [Diagnostic codes](diagnostic-codes.md)
- [Compiler specification](compiler-specification.md)
