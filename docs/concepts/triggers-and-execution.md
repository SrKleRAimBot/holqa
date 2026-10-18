# Triggers and execution

> **Status:** Partly implemented. Handler registration for every trigger is **Implemented** in `@holqa/sdk`; execution of HTTP routes and RPC procedures, the common dispatcher and manual invocation (`runtime.invoke`) are **Implemented** in `@holqa/runtime-bun` ([runtime reference](../reference/runtime.md)). Queue, storage and schedule delivery are **Accepted design** — not implemented.

A **trigger** is an event source that invokes a handler. Every handler in Holqa responds to exactly one trigger, receives a typed, validated input, and runs in a Bun-based execution environment. This page describes each trigger type, its intended semantics, and the execution model.

## Trigger types

| Trigger | Resource | Phase | Status |
| --- | --- | --- | --- |
| HTTP request | `http.api` | Initial core | **Implemented** |
| RPC query / mutation | `http.api` (RPC mount) | Initial core | **Implemented** |
| Queue message | `queue` | Initial core | Accepted design (registration **Implemented**; delivery not implemented) |
| Object storage event | `bucket` | Initial core | Accepted design (registration **Implemented**; delivery not implemented) |
| Cron schedule | `schedule` | Initial core | Accepted design (registration **Implemented**; scheduling not implemented) |
| Manual / internal invocation | Any handler | Initial core | **Implemented** as `runtime.invoke`; CLI commands Proposed |
| Event topics and fan-out | `topic` (future) | Future | Planned |
| WebSocket | Future | Future | Planned |
| Reactive queries | Future | Future | Planned |
| Durable workflows | Future | Future | Planned |
| Database change events | Future | Future | Planned |
| External event integrations | Future | Future | Planned |

## HTTP

HTTP routes declare path parameters, query parameters, request headers, a JSON request body and status-specific responses (a schema per status code), with typed middleware and Fetch API interoperability (`Request`, `Response`, `ReadableStream` for streaming). This is **Implemented**; documentation metadata is recorded, and OpenAPI generation is **Planned**. The [runtime reference](../reference/runtime.md#http-routes) specifies the contract.

```ts
import { z } from "zod";
import { resources } from "../../infra";

export default resources.api.route({
  id: "orders.get",
  method: "GET",
  path: "/orders/:orderId",
  params: z.object({ orderId: z.string() }),
  responses: {
    200: z.object({ orderId: z.string(), status: z.string() }),
    404: z.object({ message: z.string() })
  },
  // `reply` keeps status and body literals precise (see ADR 0012).
  handler: async ({ params, reply }) => reply(200, { orderId: params.orderId, status: "pending" })
});
```

### Middleware

Middleware composes at the **application**, **API**, and **route** levels and may extend the typed handler context (for example adding an authenticated `user`). Authentication is provided through general-purpose middleware and optional integrations; Holqa does not require its own identity service. This is **Implemented**; ordering and semantics are in the [runtime reference](../reference/runtime.md#middleware).

### Interoperability

Because handlers speak the Fetch API, existing HTTP frameworks such as Hono should be mountable as the implementation of a route group (**Planned**). See [oRPC and Hono](../integrations/orpc-and-hono.md).

## RPC

RPC is a **specialization of the HTTP execution model**, not a separate engine. An RPC procedure is an HTTP route with a conventional path under the API's RPC mount (`<basePath>/rpc/<id>`), an input schema, an output schema, and a query/mutation classification. This is **Implemented** with Holqa's own versioned `holqa.rpc/1` protocol, which is not JSON-RPC 2.0 ([runtime reference](../reference/runtime.md#rpc-procedures)).

- Queries are side-effect-free reads; mutations change state. The classification informs client caching (for example TanStack Query keys).
- Generated browser-safe clients (**Planned**) will call procedures with full type inference ([type safety and schemas](type-safety-and-schemas.md#generated-browser-safe-clients)).
- Existing RPC libraries such as oRPC should be usable instead of, or alongside, Holqa's own procedures.

## Queues

Queues are explicit, durable logical resources. A queue declaration describes:

| Property | Purpose |
| --- | --- |
| Message schema and `schemaVersion` | Validation and evolution. |
| Retries (`maxAttempts`) and backoff | Redelivery policy after failures. |
| Dead-letter handling | Where messages go after exhausting retries. |
| Delivery requirements | Guarantees a binding must satisfy (see [infrastructure providers](infrastructure-providers.md)). |

### Single competing consumer

The initial design allows **one registered consumer handler per queue**, with configurable concurrency. Multiple concurrent invocations of that handler compete for messages. Registering two consumers for the same queue is a compiler error (planned).

Queue consumption is not event fan-out. If several independent subsystems need to react to the same event, the intended solution is a future **topic** resource with independent subscriptions, not multiple queue consumers.

### At-least-once delivery and idempotency

Handlers should assume **at-least-once** delivery: a message may be delivered more than once (after a timeout, a crash, or a redelivery by the underlying service). Consequences:

- Handlers should be idempotent, for example by keying side effects on `message.orderId`.
- The delivery context exposes the attempt number (`delivery.attempt`) so handlers can observe redelivery.
- The local environment and test utilities are designed to simulate duplicate delivery, so idempotency can be tested ([local development](local-development.md)).

Exactly-once delivery is not promised. A binding that offers stronger guarantees is welcome, but application code must not depend on them unless the requirement is declared and verified.

### Dead-letter queues

When `deadLetter: true` is declared, messages that exhaust `maxAttempts` move to a dead-letter destination rather than being dropped. A binding that cannot provide dead-lettering must fail capability validation rather than silently discard messages.

The following code uses the implemented registration API; queue delivery that would invoke it is not implemented.

```ts
export default resources.orders.consume({
  id: "orders.process",
  concurrency: 10,
  handler: async ({ message, delivery }) => {
    if (await alreadyProcessed(message.orderId))
      return;
    await processOrder(message);
  }
});
```

## Storage events

Object storage resources (`bucket`) are designed to support basic object operations, signed URLs, access policies, and **object-created** and **object-deleted** event handlers.

- Event payloads are portable (bucket identifier, object key, size, content type, event time), not provider-specific event shapes.
- Provider-specific storage interfaces must not leak into the portable SDK.
- Event ordering and delivery guarantees vary between providers; handlers should tolerate duplicates and out-of-order events.

## Schedules

Schedules describe:

| Property | Purpose |
| --- | --- |
| `cron` | A cron expression. |
| `timezone` | An explicit IANA timezone (for example `UTC`). Daylight-saving transitions can skip or repeat local times; the documented behavior must be explicit. |
| `overlap` | What happens if a run is still in progress when the next is due, for example `skip` (do not start) or `allow` (run concurrently). The full policy set is **Proposed**. |
| Handler association | One handler per schedule. |

Missed runs (for example while the application is down) are not automatically backfilled unless a future policy requests it.

## Manual and internal invocations

Any handler can be invoked directly, without the real trigger, through `runtime.invoke({ handlerId, input, metadata })` (**Implemented**). This is the basis for the proposed CLI commands `holqa invoke`, `holqa queue send`, `holqa storage put`, and `holqa cron run`, and for the `@holqa/testing` package. **None of these commands are implemented**; today they exit with `HOLQA_CLI_NOT_IMPLEMENTED` ([CLI reference](../reference/cli.md)).

## Future triggers

The resource model is designed so that new trigger types can be added as new resource kinds without changing existing ones:

| Future trigger | Design notes |
| --- | --- |
| Topics and fan-out | Independent subscriptions, each with its own delivery state. |
| WebSockets | Builds on the HTTP model and Fetch-compatible upgrade handling. |
| Reactive queries | Requires change tracking in the underlying data store. Holqa will not promise automatic database reactivity without that infrastructure. |
| Durable workflows | Requires durable execution state, replay, and versioning. |
| Database change events | Depends on provider capabilities (for example logical replication). |
| External event integrations | Third-party webhooks and event streams with validated payloads. |

## Execution model

Bun is the primary runtime ([ADR 0002](../architecture/decisions/0002-bun-as-primary-runtime.md)). The execution model below is **Implemented** for HTTP routes and RPC procedures by one dispatcher shared by every trigger ([ADR 0023](../architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md), [runtime reference](../reference/runtime.md#invocations)):

- An **application execution environment** is a runtime (`createRuntime`) in a Bun process that hosts one application instance, its binding and its application-scoped values. Running several isolated environments per application (workers, processes) is **Planned**.
- It supports **multiple concurrent invocations**, subject to explicit limits: per-handler concurrency (for example a queue consumer's `concurrency`), and environment-wide resource limits.
- Each invocation receives a typed context: the validated input, trigger metadata (such as `delivery.attempt`), typed resource handles, and configuration.
- Handlers must not rely on in-memory state surviving between invocations, because environments may scale, restart, or reload.
- Inputs are validated before the handler runs ([type safety and schemas](type-safety-and-schemas.md#runtime-validation-at-trust-boundaries)). Unhandled errors are normalized into structured diagnostics (`HOLQA_HANDLER_FAILED`, with details only in logs) and, for queues, are designed to lead to redelivery according to the retry policy (not implemented).

Bun as the framework runtime is separate from dependency management: this repository uses pnpm, and applications built with Holqa may use any package manager.

## Related

- [Resource graph](resource-graph.md)
- [Local development](local-development.md)
- [Infrastructure providers](infrastructure-providers.md)
- [Integrations](../integrations/index.md)
