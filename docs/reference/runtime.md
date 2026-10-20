# Runtime

> **Status:** **Implemented** in `@holqa/runtime-bun` (dispatcher, lifecycle, HTTP routes, RPC procedures, queue, object event and schedule delivery, `Bun.serve` adapter), `@holqa/sdk` (`route`, `procedure`, `reply`, `middleware`, `scoped`, queue, bucket and schedule operations) and `@holqa/core` (wire contracts, delivery sources, cron evaluation), including event lineage, event limits and handler idempotency ([event safety](../concepts/event-safety.md)). Reloads are **Implemented** by `holqa dev` as process restarts, one process per generation ([ADR 0025](../architecture/decisions/0025-dev-supervisor-and-process-generations.md), [CLI reference](cli.md)); in-process module reloading and worker isolation are **Planned**. All packages are private and unpublished.

This page specifies how a Holqa application executes: the invocation lifecycle shared by every trigger, the HTTP route contract, the `holqa.rpc/1` protocol, middleware ordering, and how queue messages, object events and scheduled runs are delivered. The design is recorded in [ADR 0023](../architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md) and [ADR 0024](../architecture/decisions/0024-event-delivery-sources-and-local-drivers.md). The local binding that delivers them on one machine is described in the [local environment reference](local.md).

## Layers

| Package | Responsibility |
| --- | --- |
| `@holqa/core` | Runtime-neutral contracts: the `http.procedure` trigger kind, `HttpInvocationInput`, `HttpRejectedError`, `HttpErrorBody`, the `holqa.rpc/1` envelope types and constants, `ApplicationScope` and `ScopedDefinition`. |
| `@holqa/sdk` | Declarations: `api.route`, `api.procedure`, `reply`, `middleware`, `scoped`, application and API middleware. Each registration's `invoke` validates the request, runs the middleware chain and the handler, and checks the response. Runtime-neutral. |
| `@holqa/runtime-bun` | Execution: `createRuntime` (dispatcher, lifecycle, router, CORS, error responses, logs, delivery workers for queues and object events, schedule runs), `loadCompiledApplication`, and `serve` (`Bun.serve`). Depends on `@holqa/core` only and reads descriptors; it never imports the SDK. |
| Bindings | Fulfil resources: drivers for handle operations, and sources the runtime consumes. `@holqa/local` is the first binding with sources ([local environment](local.md)); provider bindings are **Planned**. |

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
| `handlerSources` | none | Where each handler is implemented, `<module>#<export>` relative to the application root, by handler identifier; logged as `source` with failed invocations. `loadCompiledApplication` returns it, so `createRuntime({ ...compiled })` passes it on. |
| `binding` | environment binding | The binding: drivers, sources and configuration. The default serves `http.api` only and reads configuration from `env`; it advertises no queue, bucket or schedule capability, so such applications fail to start with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`. Use `createLocalEnvironment(...).binding` from `@holqa/local` to run them locally. |
| `delivery.concurrency` | `4` | In-flight messages per queue consumer that declares no `concurrency`. |
| `delivery.leaseMs` | `limits.timeoutMs` + 5 000 (300 000 when `limits.timeoutMs` is `Infinity`) | How long a received message or event stays leased. When the binding's source can extend leases, the runtime renews them every half lease while the handler runs; otherwise the lease must outlast the invocation time limit, or a slow handler's delivery runs again concurrently. |
| `delivery.objectEvents` | 3 attempts, default backoff, dead-lettered, concurrency 4 | How object event handlers treat failures; buckets declare no retry policy. |
| `env` | `process.env` | Environment variables for the default binding. |
| `limits.concurrency` | `256` | Concurrent invocations across all handlers. |
| `limits.queue` | `1024` | Invocations waiting for a slot; beyond it, `HOLQA_RUNTIME_OVERLOADED`. |
| `limits.timeoutMs` | `30000` | Time limit per invocation, including waiting for a slot. `Infinity` means none; longer finite values are capped at 2^31 − 1 ms. |
| `events.maxDepth` | `16` | The deepest event a handler receives, in hops from its root operation; handlers override it with `events.maxDepth`. See [event lineage and limits](#event-lineage-and-limits). |
| `events.maxPublications` | `1000` | The most events one invocation may publish; handlers override it with `events.maxPublications`. |
| `events.maxEventAgeMs` | none | Deliveries sent longer ago than this are not delivered. Applies when the binding reports `LeasedDelivery.sentAt`. |
| `events.maxEventsPerOperation` | none | The most events one root operation may publish in total. Requires a binding with `operationBudgets`; otherwise `start()` fails with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`. |
| `http.cors` | none | [CORS](#cors) policy. |
| `http.trustCorrelationHeader` | `true` | Adopt a caller's `x-correlation-id` (at most 128 letters, digits, `_`, `.`, `:`, `-`). Set `false` for servers exposed to untrusted callers, so logs never contain caller-chosen identifiers. |
| `manualTriggers` | `false` | Run queue, object event and schedule handlers only through `runtime.invoke`: the runtime consumes no source. Without it, `start()` fails with `HOLQA_RUNTIME_START_FAILED` and one `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` cause per handler whose trigger the binding cannot deliver. |
| `log` | JSON lines on standard output | A `LogSink`; `silentSink` discards. |
| `createId`, `now`, `clock` | `crypto.randomUUID`, `performance.now`, `new Date()` | Injectable for deterministic tests. |

`createRuntime` is synchronous and side-effect free. It reports every problem at once in one `HolqaError`: a value that is not an application (`HOLQA_APP_INVALID`), a non-handler (`HOLQA_DECLARATION_INVALID`), two registrations with one identifier (`HOLQA_HANDLER_ID_DUPLICATE`), a trigger on an undeclared resource (`HOLQA_RESOURCE_NOT_FOUND`) or a resource of another kind (`HOLQA_TRIGGER_INVALID`), two handlers serving the same method and path shape across all APIs (`HOLQA_ROUTE_CONFLICT`, the same rule the compiler applies), two consumers of one queue (`HOLQA_QUEUE_CONSUMER_DUPLICATE`), and invalid limits, event limits, delivery or CORS settings (`HOLQA_RUNTIME_START_FAILED`). `start()` also fails with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` when a handler declares `idempotency` and the binding has no idempotency store, or `events.maxEventsPerOperation` is set and the binding has no operation budget store. These checks repeat the compiler's for registrations that were never compiled; the route rule is the shared `httpRouteKeys` function from `@holqa/core`.

## Execution lifecycle

| State | Entered by | Accepts invocations |
| --- | --- | --- |
| `idle` | `createRuntime` | No (`HOLQA_RUNTIME_NOT_RUNNING`) |
| `starting` | `start()` | No |
| `running` | `start()` succeeded | Yes |
| `stopping` | `stop()` | No; in-flight invocations continue |
| `stopped` | `stop()` finished, or `start()` failed | No |

`start()` runs once. It creates the binding (validating every configuration entry; see [configuration](#configuration)), checks that the binding can deliver every background handler's trigger, installs it with `bindApp`, and then subscribes to the binding's sources (a source can still fail here, for example a schedule with `HOLQA_SCHEDULE_INVALID`). A failure throws `HOLQA_RUNTIME_START_FAILED` followed by its causes and leaves the runtime `stopped`; create a new runtime to retry. Calling `stop()` while `start()` is still running makes the start fail (`HOLQA_RUNTIME_NOT_RUNNING`) and never installs the binding.

`stop({ graceMs = 10000, forceMs = 1000 })` is idempotent; concurrent calls share one stop. It:

1. stops receiving queue messages, object events and scheduled runs, and refuses new invocations;
2. waits up to `graceMs` for admitted invocations to finish, including those still waiting for a slot; scoped values stay usable meanwhile;
3. aborts the remaining ones (their callers receive `HOLQA_INVOCATION_CANCELLED`) and waits up to `forceMs` for handler code that ignores its signal, logging a warning if some is still running;
4. settles every delivery with its source: finished ones are acknowledged, retried or dead-lettered as usual, and those cancelled by the stop are released for immediate redelivery;
5. aborts the application scope's `signal` and disposes of scoped values in reverse creation order (a failing `dispose` is logged, and the others still run);
6. removes the binding.

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
| Identity | Every invocation gets a unique `invocationId`; `correlationId` groups related invocations (a trace) and defaults to it. Both are in the handler's context, every log entry and the `x-correlation-id` response header. `causationId` (optional in `InvocationRequest`) names the invocation that caused this one and is logged; see [traces](#traces). |
| Outcome | `invoke` never rejects. It resolves to `{ ok: true, value }` or `{ ok: false, failure }`, both with `invocationId`, `correlationId`, `handlerId`, `durationMs`, `lineage` (`{ correlationId, causationId?, rootId, depth }`), `blocked` (`{ code, message }`, only when an event limit refused something the handler tried to publish) and `emitted`: the messages the handler sent and objects it changed before the outcome (`EmittedEvent`: `{ type: "queue.message", resourceId, messageId }` or `{ type: "object.created" \| "object.deleted", resourceId, key }`), in order, empty when the handler did not run. A send that failed, and a delete of an object that did not exist, are not listed. |
| Concurrency | A FIFO gate of `limits.concurrency` slots with a wait queue of `limits.queue`. A queue consumer's own `concurrency` is a second gate, acquired first, so invocations waiting for it hold no environment-wide slot. A full queue answers `HOLQA_RUNTIME_OVERLOADED` at once. |
| Metadata | Trusted, but checked against the trigger kind: a queue consumer needs `{ attempt, messageId, schemaVersion? }`, an object event handler `{ eventId, eventTime, attempt }`, a schedule handler `{ scheduledTime, runId?, trigger? }`; otherwise `HOLQA_INPUT_INVALID`. |
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

An application instance can be bound to one runtime at a time: starting a second runtime on the same instance fails with `HOLQA_RUNTIME_ALREADY_BOUND`. `holqa dev` runs each generation of an application in its own process with its own instance ([ADR 0025](../architecture/decisions/0025-dev-supervisor-and-process-generations.md)); running applications in separate workers is **Planned** ([ADR 0015](../architecture/decisions/0015-runtime-generations-and-reload.md)); the runtime API takes everything it needs as explicit options so that a deployment adapter can create one runtime per isolated environment.

### Configuration

The default binding validates every configuration entry at `start()`: the environment variable, or the declared default when it is unset, must satisfy the entry's schema (values are strings; use coercing schemas such as `z.coerce.number()`). Problems are reported together as `HOLQA_CONFIG_INVALID`; a secret is reported by name only, without its value or the schema's message.

### Logs

Entries are JSON objects with `level`, `time` and `message`, then context fields (`application`, `handlerId`, `invocationId`, `correlationId`, `triggerKind` and `resourceId` of the handler's trigger, `causationId` when the invocation has a cause, `rootId` and `depth` unless the invocation is its own root at depth 0 (HTTP requests, scheduled runs, direct invocations; an untraced delivery logs its message or event identifier as root), `method` and `path` for HTTP, and `deliveryId` and `attempt` for queue messages and object events, `runId` for scheduled runs), then the fields a handler passes to `log.info/warn/error`. Fields cannot replace `level`, `time` or `message`; a handler field with the same name as a context field replaces it in that entry. The runtime writes `runtime started`, `invocation completed` (`outcome`, `durationMs`, `emitted` when the handler emitted anything, and `blocked` with the guard's code when an event limit refused a publication), `invocation failed` (`code`, `durationMs`, `emitted`, `blocked`, `source` when `handlerSources` names the handler, and `error` with name, message, stack and diagnostics; level `error` for server errors), `request rejected` (unmatched requests), and `runtime stopped`. Request and response bodies are never logged.

### Traces

A trace is every invocation that shares one `correlationId`. When handler code sends a message or writes or deletes an object, the runtime passes the running invocation's trace to the driver as `DriverOperationContext.trace` (`{ correlationId, causationId, rootId, depth }`, where `causationId` is the sending invocation's `invocationId` and `depth` is one more than its own) and records the operation in `emitted`. A binding that stores the trace returns it with each resulting delivery (`LeasedDelivery.trace`); the queue or object event invocation then uses the delivery's `correlationId` and logs its `causationId`. Without a trace (a binding that does not store one, or a message sent outside an invocation) the delivery's `correlationId` is the message or event identifier, as before. Scheduled runs use their `runId`. The runtime finds the running invocation with `AsyncLocalStorage`, so operations that handler code starts are attributed to it even when they finish later; work a handler leaves running after its outcome is not listed in `emitted`. The trace is not part of the `holqa.message/1` envelope or of any resource contract.

### Event lineage and limits

Every invocation has a lineage: its `correlationId`, the invocation that caused it (`causationId`), the root operation it descends from (`rootId`) and its distance from that root (`depth`). HTTP requests, scheduled runs, direct invocations and deliveries without a trace are roots at depth 0 (an untraced delivery's root is its message or event identifier, so its retries share one root). `rootId` is always assigned by the runtime; `InvocationRequest.rootId` and `depth` are for trusted callers such as transports, and an HTTP caller's `x-correlation-id` never sets them. Retries, lease expiries and duplicates keep the delivery's lineage. Handlers read it as `context.lineage`.

Before handler code's send, write or delete reaches the binding, the runtime checks it against the event limits. Only events that a registered handler receives count: a send to a queue with a consumer, a write or delete in a bucket with a handler for that event type whose prefix matches the key.

| Check | Limit | Refusal |
| --- | --- | --- |
| The invocation's published events | `maxPublications` of the publishing handler (default 1000) | `HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED` |
| The new event's depth (the invocation's depth + 1) | `maxDepth` of every receiving handler (default 16) | `HOLQA_EVENT_DEPTH_EXCEEDED` |
| The root operation's published events | `events.maxEventsPerOperation`, counted atomically by `binding.operationBudgets` | `HOLQA_EXECUTION_BUDGET_EXCEEDED` |

A refusal throws a `HolqaError` with that code in the handler, and the operation does not happen. Before a queue message or object event is delivered, its depth is checked against the receiving handler's `maxDepth` and, when `maxEventAgeMs` is set and the binding reports `sentAt`, its age (`HOLQA_EVENT_AGE_EXCEEDED`).

These outcomes are **terminal**: a delivery refused before delivery, or whose handler failed after a refusal (even when the handler replaced the guard's error with its own), is dead-lettered (or discarded, when no dead-letter destination is required) at once, with the guard's code as its failure, and never retried. A handler that catches a refusal and succeeds is acknowledged; `blocked` on its outcome still records the refusal. HTTP callers receive status 500 with the guard's code and a generic message. `stats().delivery.queues.blocked` and `objectEvents.blocked` count terminal refusals.

Depth and publication limits are enforced by the runtime in its own process, for every binding. The per-operation budget is only as strong as the binding's store: the runtime refuses to start rather than enforce it partially. See [event safety](../concepts/event-safety.md#limits).

### Handler idempotency

A queue consumer or object event handler declared with `idempotency` claims its key (the message or event identifier, or the declared key function's result) in `binding.idempotency` before it runs: a completed key skips the handler and acknowledges the delivery (logged as `duplicate delivery skipped; its idempotency key already completed`), a key held by another delivery fails with `HOLQA_IDEMPOTENCY_IN_PROGRESS` (status 503, retried with the queue's backoff), and a failed handler releases its key. A claim is renewed every half `leaseSeconds` (default 30) while the handler runs, so only a crashed attempt keeps a key blocked, for at most one lease; completed keys are remembered for `retentionSeconds` (default one day). Keep `leaseSeconds` below the time a crashed attempt's message takes to be redelivered (`delivery.leaseMs`), or the redelivery is retried until the claim expires. This suppresses duplicate deliveries; it does not make side effects exactly-once. See [idempotency](../concepts/event-safety.md#idempotency).

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

## Queue delivery

```ts
export const jobs = queue({
  id: "document-jobs",
  message: documentJob,
  schemaVersion: 1,
  delivery: { maxAttempts: 3, deadLetter: true, backoff: { strategy: "exponential", initialDelaySeconds: 2, maxDelaySeconds: 30 } }
});

const { messageId } = await resources.jobs.send(job, { delaySeconds: 60 });

export default resources.jobs.consume({
  id: "documents.process",
  concurrency: 4,
  handler: async ({ message, delivery }) => {
    // delivery.messageId is the same for every delivery of one sent message.
    if (await alreadyProcessed(delivery.messageId))
      return;
    await process(message);
  }
});
```

`send` encodes the message in its schema's input form, validates the encoded copy, wraps it in a `holqa.message/1` envelope with the queue's `schemaVersion`, and resolves with the identifier the queue assigned once it has accepted the message. `delaySeconds` (a whole number, at least 0) delays the first delivery; a delay longer than the binding's `maxDelaySeconds` fails with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`, and a malformed one with `HOLQA_OPERATION_INVALID`.

A queue has **one competing consumer**. The runtime runs a delivery worker for it that leases messages from the binding's queue source and invokes the consumer through the dispatcher:

| Rule | Behaviour |
| --- | --- |
| Delivery | At least once. A message is leased to one receiver for `delivery.leaseMs`, renewed while its handler runs when the source supports it; when the lease expires before it is settled (a crash, a hang), it becomes due again with a higher `attempt`. Duplicates are possible: make consumers idempotent. Order is not guaranteed. |
| Concurrency | At most the consumer's `concurrency` (default `delivery.concurrency`) messages are leased and running at once. |
| Success | The message is acknowledged and not delivered again. |
| Failure | Any error, timeout or cancellation other than shutdown is a failed attempt. Before the last attempt, the message is retried after the backoff delay: `fixed` waits `delaySeconds`; `exponential` waits `initialDelaySeconds × multiplier^(attempt − 1)` (multiplier 2 by default), capped at `maxDelaySeconds`. Without a declared backoff: 1 s, doubling, at most 300 s. No jitter is added. |
| Last attempt | After `maxAttempts` (the binding's default when not declared) the message is dead-lettered when the queue declares `deadLetter: true`, and discarded otherwise. Dead-lettered messages keep their payload and the last failure (`code`, `message`, `invocationId`). |
| Not retried | A payload that fails the message schema (`HOLQA_INPUT_INVALID`), an older `schemaVersion` than the consumer's (`HOLQA_PAYLOAD_VERSION_UNSUPPORTED`), a body that is not an envelope (`HOLQA_PAYLOAD_MALFORMED`), and a message received more often than its attempts allow (`HOLQA_DELIVERY_ATTEMPTS_EXHAUSTED`) are dead-lettered (or discarded) at once, without invoking the consumer. |
| Newer versions | A message with a newer `schemaVersion` than the consumer's, as when producers are deployed first, is a failed attempt (`HOLQA_PAYLOAD_VERSION_UNSUPPORTED`) without invoking the consumer: it is retried with the backoff, so an updated consumer can take it, and dead-lettered (or discarded, when the queue requires no dead-letter destination) after the last attempt. Deploy consumers before producers when a queue requires no dead-letter destination. |
| Shutdown | Messages whose invocation the stop cancelled are released for immediate redelivery; the attempt still counts. |
| Event limits | A delivery deeper than the consumer's `maxDepth` or older than `maxEventAgeMs`, and a delivery whose handler ran into an event limit, are dead-lettered (or discarded) at once with the limit's code. See [event lineage and limits](#event-lineage-and-limits). |
| Context | `message` (validated output), `delivery.attempt`, `delivery.messageId`, `delivery.schemaVersion`, `lineage`, `signal`, `log`. |

Binding requirements are checked when the runtime starts: a queue that requires more attempts, a dead-letter destination, a backoff strategy or longer delays than the binding advertises fails with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`, and so does a queue without a declared backoff when the binding cannot delay redeliveries by the default's 300 seconds (`checkTriggerDelivery` in `@holqa/core`). Topics, where several subscribers each receive every message, are **Planned**; queues never fan out.

### Publishing and database writes

Sending a message and writing to a database are separate operations. Holqa does not make them atomic: the database write can succeed and the send fail, or the send succeed and the transaction roll back. Applications that need both to happen choose one of these patterns:

| Pattern | How |
| --- | --- |
| Transactional outbox | Write the message to an outbox table in the same database transaction as the change. A separate process (a schedule handler works) sends outbox rows and marks them sent. Sending is then at least once, so the consumer must be idempotent. |
| Idempotent consumers | Key side effects on `delivery.messageId` or on a business key in the message (`orderId`), and record processed keys in the same transaction as the effect. A duplicate then changes nothing. |
| Send last, tolerate loss | Send after committing and accept that a crash in between loses the message; only for messages that can be recomputed, for example by a schedule. |

Consumers must never assume that a message implies the producer's database change is visible, or that it is delivered only once.

## Object events

```ts
export const queueUpload = resources.files.onObjectCreated({
  id: "uploads.queue",
  prefix: "uploads/",
  handler: async ({ object, event }) => {
    // object: { key, size, contentType? }; event: { id, time, attempt }
    await resources.jobs.send({ key: object.key });
  }
});

export const recordRemoval = resources.files.onObjectDeleted({ id: "uploads.removed", handler: async ({ object }) => audit(object.key) });
```

Buckets support `put` (resolves to metadata with an opaque `etag`), `get`, `head`, `delete` (resolves to `false` when the object did not exist), `list({ prefix?, cursor?, limit? })` (pages of at most 1 000 keys in UTF-8 byte order; pass the returned `cursor` for the next page) and `signedUrl(key, { method: "GET" | "PUT", expiresInSeconds, contentType? })`. Keys must be 1 to 1 024 UTF-8 bytes without control characters, a leading `/`, or `.` and `..` segments (`HOLQA_OBJECT_KEY_INVALID`). Signed URLs require the binding's `signedUrls` capability; what their signature protects is documented by the binding ([local signed URLs](local.md#signed-urls)).

Every change produces one event in the portable `holqa.object-event/1` envelope:

```json
{
  "format": "holqa.object-event/1",
  "id": "8d0f…",
  "type": "object.created",
  "bucket": "document-files",
  "time": "2026-10-18T09:30:00.000Z",
  "object": { "key": "uploads/a.txt", "size": 21, "contentType": "text/plain", "etag": "…" }
}
```

| Rule | Behaviour |
| --- | --- |
| Types | `object.created` (also for a replaced object) and `object.deleted` (key only). Deleting a missing object produces no event. |
| Subscriptions | Each handler is a subscription with its own delivery state, filtered by type and optional `prefix`. Events that happened before a subscription first existed are not delivered to it. |
| Identity | `event.id` is the same for every delivery of one change; two writes of one key are two events. Discard duplicates by `event.id`, or make the effect idempotent. |
| Delivery | At least once, in no guaranteed order, with the same lease, retry and dead-letter mechanics as queues. Buckets declare no retry policy: `delivery.objectEvents` is a deployment setting of the runtime, not part of the application's declared requirements, so every runtime that runs the application must pass the same values to behave the same way. |
| Subscriptions as infrastructure | Against external services, a subscription (a notification configuration) is infrastructure that provisioning creates; a driver attaches to it and fails when it is missing, rather than creating it with data-plane credentials. The local binding creates its own subscriptions. |
| Input | The handler validates the portable object description (`{ key, size, contentType? }` or `{ key }`); the event's identity, time and attempt are trusted metadata. |
| Event limits and idempotency | As for queues: a handler's writes and deletes are checked against the [event limits](#event-lineage-and-limits) (only events a handler with a matching prefix receives count), deliveries carry their `lineage`, and a handler can declare `idempotency` (default key: `event.id`). |

Drivers for external storage services translate their notifications into this envelope; `readObjectEvent` from `@holqa/core` checks its structure.

## Scheduled runs

```ts
export const cleanup = schedule({ id: "upload-cleanup", cron: "0 * * * *", timezone: "UTC", overlap: "skip" });

export default resources.cleanup.handle({
  id: "uploads.cleanup",
  handler: async ({ scheduledTime, trigger, runId }) => removeOlderThan(Date.parse(scheduledTime) - ttl)
});
```

The time zone, daylight-saving and missed-run rules below are what every schedule binding must implement; a binding evaluates them itself (the local scheduler uses `parseCronSchedule` and `nextCronTime` from `@holqa/core`) or translates them faithfully for a service, and must refuse a schedule it cannot honour. The overlap policy is applied by the runtime.

| Rule | Behaviour |
| --- | --- |
| Cron | Five fields: minute, hour, day of month, month (`1-12` or `JAN-DEC`), day of week (`0-7` or `SUN-SAT`; `0` and `7` are Sunday), each a value, range, step (`*/15`, `5-20/5`) or list. `?` means `*` in the day fields. When both day fields are restricted, a day matches if either does. `L`, `W`, `#` and seconds are rejected at declaration (`HOLQA_DECLARATION_INVALID`) and by bindings (`HOLQA_SCHEDULE_INVALID`). |
| Time zone | Fields match the wall clock in the declared IANA time zone, at minute precision. An unknown zone, or a schedule that never fires (`0 0 31 2 *`), fails when the runtime starts (`HOLQA_SCHEDULE_INVALID`). |
| Daylight saving | A matching local time that does not exist (clocks jump forward) runs once, at the first instant after the gap. A local time that occurs twice (clocks fall back) runs once, at its first occurrence. Each matching wall-clock time therefore runs at most once per day. |
| Overlap | Enforced by the runtime. `skip`: a run due while the previous one of the same schedule is still in progress is not started and is reported `skipped` (`HOLQA_SCHEDULE_RUN_SKIPPED`). `allow`: runs overlap. |
| Missed runs | Not backfilled. Runs due while no runtime receives the schedule (the application is stopped) never run. When a scheduler wakes up late, only the most recent due run starts; the binding may record the earlier ones as missed. |
| Duplicates | A scheduler service may report the same run more than once. Make schedule handlers idempotent, keyed on `scheduledTime` (or `runId` where the binding keeps it stable). The local scheduler reports each run once, which is stronger than many services. |
| Manual runs | Started by the binding (for example `scheduler.trigger(id)` in `@holqa/local`) with `trigger: "manual"` and `scheduledTime` set to the request time, through the same overlap policy. |
| Results | The runtime reports every run's outcome (`succeeded`, `failed` with the failure code, or `skipped`) and invocation identifier back to the scheduler, which can record it. `scheduledTime` is when the run was due, not when it started. |

## Compiled applications

`loadCompiledApplication({ root, buildDir? })` reads `manifest.json` and `entrypoints.json` written by `holqa build --manifest`, imports the application module and each handler module, and returns `{ app, handlers, manifestFingerprint, handlerSources }` for `createRuntime`. It fails with `HOLQA_APP_NOT_FOUND` without build output, `HOLQA_MANIFEST_INVALID` for malformed output (including module paths outside the root), `HOLQA_MANIFEST_VERSION_UNSUPPORTED` for another manifest version, `HOLQA_APP_INVALID` when the application module's default export is not an application, `HOLQA_MODULE_EVALUATION_FAILED` when a module throws, and `HOLQA_BUILD_STALE` when the entry point map belongs to another manifest or the application name, resources (kind, identifier, settings, requirements), configuration entries, handler exports or triggers changed since the build. Schema changes and handler modules added after the build are not detected; rebuild after changing either.

Loading evaluates the application's code in the current process with its permissions. It is not a sandbox; load only build output you trust.

## Bun and other runtimes

`createRuntime` and `runtime.fetch` use Web-standard APIs (`Request`, `Response`, `URL`, `AbortController`, `crypto.randomUUID`, timers) plus the global `process.env` as the default environment, and `AsyncLocalStorage` from `node:async_hooks` (available in Bun and Node) to attribute resource operations to invocations. `serve` uses `Bun.serve`, and `loadCompiledApplication` uses `Bun.file`, `node:path` and `node:url`; both need Bun 1.3.13 or later. `serve` binds `127.0.0.1` by default, limits request bodies to 1 MiB (Bun answers larger ones with `413`), and does not use `stop(false)`, which on Bun 1.3.13 leaves keep-alive connections open.

## Not implemented

| Capability | Status |
| --- | --- |
| Bindings for external queue, storage and scheduling services | Planned |
| Topics with independent subscriptions (fan-out) | Planned |
| Reload by process restart (`holqa dev`) | **Implemented** in `@holqa/cli` ([ADR 0025](../architecture/decisions/0025-dev-supervisor-and-process-generations.md)) |
| In-process module reloading, worker isolation per application | Planned |
| Middleware for background triggers | Planned |
| Queue backlog thresholds, per-operation budgets on bindings other than `@holqa/local` | Planned |
| CORS and body limits declared in the application | Proposed |
| OpenAPI documents, generated clients | Planned |

## Related

- [ADR 0023](../architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md)
- [ADR 0024](../architecture/decisions/0024-event-delivery-sources-and-local-drivers.md)
- [ADR 0026](../architecture/decisions/0026-event-safety-analysis-lineage-and-execution-guards.md)
- [Event safety](../concepts/event-safety.md)
- [Local environment](local.md)
- [Triggers and execution](../concepts/triggers-and-execution.md)
- [Packages](packages.md)
- [Diagnostic codes](diagnostic-codes.md)
- [Compiler specification](compiler-specification.md)
