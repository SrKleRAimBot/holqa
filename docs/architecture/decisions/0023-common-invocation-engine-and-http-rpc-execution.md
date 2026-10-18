# 0023. A common invocation engine, with HTTP and RPC as its first transports

- **Status:** Proposed
- **Date:** 2026-10-18
- **Deciders:** Holqa maintainers
- **Refines:** [ADR 0007](0007-separate-compiler-and-runtime.md), [ADR 0012](0012-source-inferred-types-and-reply-helpers.md), [ADR 0015](0015-runtime-generations-and-reload.md), [ADR 0020](0020-runtime-binding-resolution.md), [ADR 0022](0022-manifest-v1-and-entry-point-map.md) decision 4. It supersedes none of them; see [relation to accepted ADRs](#relation-to-accepted-adrs).

> **Implementation status:** Implemented in `@holqa/runtime-bun`, `@holqa/sdk` and `@holqa/core` for HTTP routes and RPC procedures. Queue, object event and schedule transports are implemented as decided in [ADR 0024](0024-event-delivery-sources-and-local-drivers.md), which also moves the check for undeliverable handlers (decision 3) from `createRuntime` to `start`. Worker or process isolation is planned. See the [runtime reference](../../reference/runtime.md).

## Context

Compiled applications (manifest version 1, [ADR 0022](0022-manifest-v1-and-entry-point-map.md)) could not run: no runtime existed, routes could only be declared as an `http.api` resource, and RPC procedures and middleware were open questions in the [API design](../../reference/api-design.md#open-questions). The M0 runtime experiment ([findings](../../../experiments/runtime-bun/README.md)) validated generation pinning, orphans that keep their concurrency slots, cooperative cancellation and runtime-owned drivers, and requested a generic handler-failure code.

HTTP is the first trigger to execute, but queues, storage events and schedules follow. If each trigger builds its own invocation path, they drift: different time limits, different error shapes, different logging, different cancellation. Several constraints apply:

- `@holqa/runtime-bun` may depend on `@holqa/core` only ([package boundaries](../package-boundaries.md)). It reads descriptors and must not import the SDK.
- Middleware must extend a typed context and be checked at compile time, which only the SDK's types can express; descriptors carry JSON metadata and one executable `invoke` per handler.
- RPC must reuse HTTP rather than become a second engine ([triggers and execution](../../concepts/triggers-and-execution.md#rpc)), must be versioned, and must not imply JSON-RPC 2.0 compatibility.
- Handler errors must not leak to callers, but callers must learn whether *they* sent a bad request. A `HOLQA_INPUT_INVALID` raised by request validation and one raised by handler code (an invalid queue `send`) have the same code.
- In-process cancellation is cooperative only (M0).

## Decision

1. **One dispatcher.** Every invocation is a normalized request `{ handlerId, input, metadata, signal, correlationId, timeoutMs }` dispatched by one engine that assigns invocation and correlation identifiers, applies a global FIFO concurrency gate with a bounded wait queue (plus a handler's own `concurrency`), applies a time limit that includes waiting, links caller cancellation, normalizes errors and writes structured logs. It resolves to a discriminated outcome and never rejects. HTTP (`runtime.fetch`) and direct invocation (`runtime.invoke`) are transports on top of it; future triggers become further transports.
2. **Cancellation and orphans.** A timeout, caller abort or shutdown aborts the invocation's signal and settles the caller at once. Handler code that ignores the signal keeps running as an orphan and keeps its slots until it finishes. An invocation aborted before its handler starts never starts it.
3. **Lifecycle.** A runtime is one application execution context with states `idle → starting → running → stopping → stopped`. `start` validates configuration and installs the binding (`bindApp`); `stop` drains admitted invocations (including those waiting for a slot) within a grace period, cancels the rest, then disposes application-scoped values in reverse creation order and unbinds. `createRuntime` validates handlers and routes synchronously and reports every problem at once. Handlers whose trigger has no transport yet are rejected unless the caller opts into running them through `invoke` only (`manualTriggers`), so a declared trigger never silently goes undelivered.
4. **Application scope.** `@holqa/core` defines `ApplicationScope` and `ScopedDefinition`; the SDK's `scoped(...)` declares values (pools, clients) created once per runtime on first use and disposed of when it stops. The invocation context carries the scope next to per-invocation state; `InvocationContext` gains optional `correlationId` and `scope`.
5. **HTTP contract in the registration.** A route's or procedure's `invoke` receives `{ request, params }` (`HttpInvocationInput`) and resolves to a Fetch `Response`. The SDK builds it: it runs the middleware chain, reads and validates path parameters, query, headers and the JSON body, calls the handler, and checks `reply(status, body, headers?)` against the declared response schemas; the validated **output** is sent, which is how the compiler already describes `response.<status>` roles, and a procedure's `output` is treated the same way. A returned `Response` passes through unread (streaming), with only its status checked. The runtime owns routing (static segments win over parameters; conflicts across APIs are rejected with `httpRouteKeys`, the `@holqa/core` function the compiler also uses), `HEAD`/`OPTIONS`, CORS, correlation headers and error bodies.
6. **Middleware in the SDK.** Middleware is SDK code with typed context extension through `next(extension)`, `middleware.requires<Context>()` for dependencies, and compile-time chain checks. Order: application (`defineApp({ middleware })`), then API (`http.api({ middleware })`), then route or procedure, each in list order, as an onion around validation and the handler. Application middleware is kept in an SDK-private registry keyed by the application descriptor and read at invocation time; its context reaches handlers through the types of `app.resources`. Core descriptors do not model middleware.
7. **Errors.** The SDK wraps every Holqa error raised while reading the request in `HttpRejectedError` (status `400`, or `415` for media type), keeping the original code and issues. The runtime maps `HttpRejectedError` to its status and safe message, `HOLQA_RESPONSE_INVALID` to `500`, and everything else to `500 HOLQA_HANDLER_FAILED` with a generic message, logging the original error with the invocation identifier. Fifteen diagnostic codes are added; none is renamed.
8. **RPC as HTTP.** A procedure is a new trigger kind, `http.procedure` (`{ operation: "query" | "mutation" }`, schemas `input?` and `output`), served at `<basePath>/rpc/<id>`: `POST` for both operations, `GET` for queries with a JSON `input` query parameter. Requests are `{ "input": ... }`; responses are `holqa.rpc/1` envelopes `{ format, ok: true, output }` or `{ format, ok: false, error }`; the optional `holqa-rpc-version` header pins version `1`. The compiler and runtime check RPC paths for conflicts with routes.
9. **Manifest version 1 is extended, not replaced.** The manifest JSON Schema gains the `http.procedure` trigger and the schema roles `headers`, `input` and `output`. Manifests that use none of them are unchanged byte for byte; readers built before this change reject manifests that do. This deliberately relaxes ADR 0022's "any new field is a new version" for additions that leave every existing manifest valid and unchanged, while no package is published.
10. **Compiled applications.** `loadCompiledApplication` reads `holqa build --manifest` output, verifies the entry point map's manifest fingerprint, imports the modules it names and fails with `HOLQA_BUILD_STALE` when the application, resources, handler exports or triggers no longer match. `serve` adapts a runtime to `Bun.serve`; the runtime itself uses Web-standard APIs only.

### Relation to accepted ADRs

- **ADR 0007** (the runtime does not re-analyse source): the runtime evaluates the modules the entry point map names, because executing handlers requires their code, but it does not discover handlers or describe schemas. Its load-time checks only confirm that the evaluated code still matches the manifest (`HOLQA_BUILD_STALE`).
- **ADR 0012** (`reply` helpers): implemented as decided, `reply(status, body, headers?)`.
- **ADR 0015** (load-time validation uses the compiler's contract-layer function): the route-conflict rule is the shared `httpRouteKeys`; to make it shared, the compiler now applies it across every API of an application, as the runtime must. `createRuntime` also checks duplicate handler identifiers and resource references, because it accepts registrations that were never compiled; those checks report the same codes as the compiler. Moving them into a shared core function is follow-up work.
- **ADR 0022** decision 4: see decision 9 above.

## Consequences

### Positive

- Every trigger added later inherits identifiers, limits, cancellation, error normalization and logging instead of re-implementing them; `runtime.invoke` already runs schedule and queue handlers manually.
- The runtime keeps its single `@holqa/core` dependency, and the same registrations run in any runtime that implements the contract.
- Middleware context is checked by TypeScript, including ordering mistakes, without generated code.
- Callers get predictable, documented error bodies; internal details stay in logs.
- RPC needs no separate server, protocol stack or middleware system, and its envelope is versioned.

### Negative

- Application middleware lives outside the descriptor protocol, so only the SDK copy that defined the application applies it ([ADR 0020](0020-runtime-binding-resolution.md) already requires a single SDK copy).
- API middleware cannot be checked against application middleware's context at compile time, because APIs are declared before the application.
- Response bodies returned as `Response` objects are not validated; contracts for streamed bodies are not expressible yet.
- In-process isolation is limited to one application instance per runtime; a misbehaving handler can still block the event loop or leak module state.
- Older readers reject manifests that use procedures or header schemas.
- Applications with two APIs that share a base path and serve the same route, which compiled before, now fail compilation with `HOLQA_ROUTE_CONFLICT`; a single server could never have served both.

### Revisit when

- Background transports (queues, storage events, schedules) are implemented: confirm the request shape covers delivery attempts, acknowledgement and retries.
- A deployment adapter runs applications in workers or processes: the dispatcher may need to cross that boundary.
- Generated clients consume `holqa.rpc/1`: a version 2 must be added alongside, not in place of, version 1.
- A breaking manifest change is needed for another reason: fold these additions into manifest version 2.

## Alternatives considered

### Per-trigger execution paths

Each transport calls handlers itself. Rejected: it is the drift this decision exists to prevent.

### Middleware and validation in the runtime

The runtime would read schemas and middleware from descriptors. Rejected: typed middleware context cannot be expressed in descriptors, the runtime would need schema adapters, and executable middleware would have to enter the core protocol. The SDK already owns `invoke` for queues and schedules.

### JSON-RPC 2.0

Rejected for now: its batch and notification semantics, positional parameters and error codes do not match Holqa's schema-first, single-call model. Claiming partial compatibility would mislead clients. An adapter can be added later as a separate protocol.

### Procedures as plain `http.route` triggers

Encoding procedures as `POST` routes would leave the manifest untouched, but the query/mutation classification and the input/output roles that clients need would be lost.

### Manifest version 2

Rejected for these additions: a version bump changes every manifest's bytes and fingerprint while every existing manifest remains valid under the extended schema.

## Related

- [Runtime reference](../../reference/runtime.md)
- [Triggers and execution](../../concepts/triggers-and-execution.md)
- [ADR 0015](0015-runtime-generations-and-reload.md)
- [ADR 0022](0022-manifest-v1-and-entry-point-map.md)
- [M0 runtime experiment](../../../experiments/runtime-bun/README.md)
