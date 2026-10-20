# Event safety

> **Status:** **Implemented** for static cycle analysis (`holqa inspect --cycles`), event lineage, runtime depth, publication, age and per-operation limits, handler idempotency, controlled redrive and the simulation budget of `@holqa/testing`, in the private, unpublished packages. Queue backlog thresholds and per-operation budgets for bindings other than the local one are **Planned**. See [ADR 0026](../architecture/decisions/0026-event-safety-analysis-lineage-and-execution-guards.md).

Event-driven handlers can cause work without end: a consumer that sends to its own queue, two consumers that trigger each other, an object handler that writes into the prefix it watches, or a handler that sends several messages for every message it receives. Holqa helps in three places:

| Where | What | Guarantee |
| --- | --- | --- |
| Before running | The compiler builds an event dependency graph and reports cycles (`HOLQA_EVENT_CYCLE`). | Findings, not proof: a cycle may terminate, and some publications cannot be resolved statically. |
| While running | Every event carries its lineage; guards refuse events past a limit with a terminal outcome. | Enforced as described in [limits](#limits); never claimed where the binding cannot enforce it. |
| In tests | `createTestApp` bounds the work a test runs and explains overruns. | A test fails instead of hanging. |

## The event dependency graph

The graph has resource nodes and handler nodes. **Consumption edges** run from a resource to the handlers it triggers (a queue's consumer, a bucket's object event handlers with their prefix filters, a schedule's handler, an API's routes). **Publication edges** run from a handler to the queues and buckets it sends to, writes to or deletes from.

Publications come from two sources:

- **Analysis** of the handler's code. The compiler scans the handler function and resolves calls such as `resources.orders.send(...)`, `queue.send(...)` after `const queue = resources.orders`, `const { orders } = resources`, and `resources.images.put(key, ...)` through the evaluated modules the code imports. It follows helper functions (in the same module or in another application module, up to four calls deep) and handles passed to other functions.
- **Declarations** in the handler's `events.publishes`, for code analysis cannot follow.

Each publication has a certainty:

| Certainty | Meaning |
| --- | --- |
| `known` | A call on a resolved handle in the handler's own code, or a declared target. |
| `potential` | A resolved handle reached through a helper function or passed to another function, or an object key whose prefix cannot be compared with a handler's filter. |
| `unknown` | A `send`, `put` or `delete` call on something analysis cannot resolve. Listed as unresolved, never turned into an edge. |

Object writes are compared with prefix filters: a handler on `uploads/` that writes `thumbnails/${name}` cannot trigger itself, one that writes `uploads/${name}.copy` can, and one whose key is computed may.

The graph is part of the analysis output, not of the manifest: publications follow from handler code, which changes without changing the application's declared infrastructure. `holqa inspect --cycles` prints it; [`compileApplication`](../reference/compiler-specification.md#event-analysis) returns it as `events`.

### What analysis cannot see

Analysis reads code without running it. It does not resolve calls on function parameters, `this`, class members, values computed at run time, `let` variables, dynamic imports, or code outside the application root (including `node_modules`). It does not evaluate conditions: a call in any branch counts. Declare targets with `events.publishes` where this matters.

## Cycles

Handlers that can trigger each other form a cycle: a direct one (`orders.process` sends to `orders`) or an indirect one (`a.process` sends to `queue-b`, whose consumer sends to `queue-a`). The compiler finds them as strongly connected components of the handler graph and reports one `HOLQA_EVENT_CYCLE` per component, with a representative path and the location of its first publication:

| Cycle | Diagnostic |
| --- | --- |
| Every publication on the path is `known` | Warning |
| Some publication is `potential` | Information |
| The path passes through a handler that declares `events.cycle` | None; reported as allowed in `inspect --cycles` |

A cycle is not an error, because the compiler cannot prove whether it terminates: a handler may requeue work until a terminal state. Declaring `events.cycle` with a justification documents an intentional cycle without disabling anything else: cycles that avoid the justified handler are still reported, and the runtime limits still apply.

## Event lineage

Every invocation has a lineage:

| Field | Meaning | Set by |
| --- | --- | --- |
| `correlationId` | The business operation the invocation belongs to. | A trusted caller (for example an `x-correlation-id` header) or the runtime. |
| `causationId` | The invocation whose published event caused this one. | The runtime. |
| `rootId` | The invocation that started the causal chain. Budgets are counted per root. | The runtime only; never a caller. |
| `depth` | Event hops from the root: 0 for the root. | The runtime. |

Propagation rules:

- An HTTP request, a scheduled run, a direct invocation and a delivery without a trace (for example a message sent by `holqa queue send`) start a root at depth 0. An untraced delivery uses its message or event identifier as root, so its retries share one root.
- An event an invocation publishes carries the invocation's correlation and root, the invocation as cause, and its depth plus one.
- Retries, lease expiries, redeliveries and duplicates keep their lineage: retrying one message is not publishing a new one.
- Two requests with the same `x-correlation-id` share a correlation, but are separate roots with separate budgets.
- A delivery whose binding stored no lineage (state written before lineage existed, or a binding that does not store it) starts a new root at depth 0, rooted at its own message or event identifier. Depth limits and operation budgets therefore only span hops through bindings that store `rootId` and `depth`; the local binding does.

Handlers read their lineage as `context.lineage` (queue consumers, object event handlers and schedule handlers), for example to stop an intentional cycle after a number of hops. Telemetry trace context (`traceparent`) is **Implemented** and kept separate: sampling never changes lineage or the limits that depend on it ([observability](observability.md#lineage-is-independent-of-tracing)).

## Limits

| Limit | Default | Enforcement | On violation |
| --- | --- | --- | --- |
| `maxDepth` | 16 hops, per receiving handler (`events.maxDepth` overrides it) | Every runtime, in process: publications are refused before they reach the binding, and deeper deliveries are not delivered. | `HOLQA_EVENT_DEPTH_EXCEEDED`, terminal |
| `maxPublications` | 1000 events per invocation (`events.maxPublications` overrides it) | Every runtime, in process. Only events a registered handler receives count. | `HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED`, terminal |
| `maxEventAgeMs` | None | Needs a binding that reports when a delivery was sent (the local binding does). Age counts from the original send (or the last `--new-operation` redrive), including delays and retries. | `HOLQA_EVENT_AGE_EXCEEDED`, terminal |
| `maxEventsPerOperation` | None | Needs a binding with an atomic operation budget store (the local binding, across every process sharing its state directory). A runtime configured with it refuses to start on any other binding. | `HOLQA_EXECUTION_BUDGET_EXCEEDED`, terminal |
| Invocation time limit, concurrency, attempts and backoff | See the [runtime reference](../reference/runtime.md) | Every runtime. | Retried per the queue's policy |
| Queue backlog thresholds | — | **Planned** | — |

Depth limits alone do not stop branching storms: a handler that sends two messages per message causes about 2<sup>17</sup> invocations before the default depth limit stops it. Use `maxEventsPerOperation` where the binding supports it.

**Terminal** means the event is not retried, because a retry would run into the same limit: a refused delivery, or one whose handler failed after a refused publication (even if the handler replaced the guard's error with its own), is dead-lettered when the queue requires dead-lettering and discarded otherwise. Object events follow the runtime's `delivery.objectEvents.deadLetter` setting (dead-lettered by default).

Retries and publications are separate failure modes. A retry runs the same event again and keeps its depth; publications the retried handler makes count again, because they are new events.

## Idempotency

Delivery is at least once, so handlers can see the same message or event twice. A queue consumer or object event handler can declare `idempotency`:

- Before the handler runs, its key is claimed in the binding's idempotency store. The default key is the message identifier (queues) or the event identifier (object events); a key function can derive it from the input, which also catches duplicates sent as separate messages.
- A delivery whose key completed within the retention period is acknowledged without running the handler.
- A delivery whose key another delivery holds fails with `HOLQA_IDEMPOTENCY_IN_PROGRESS` and is retried later. The failure counts as an attempt, so a duplicate can be dead-lettered while a long-running original still holds the key; the original's outcome is unaffected.
- A handler that fails releases its key, so the retry runs it again. A running handler's claim is renewed; a crashed one's expires after one lease (`leaseSeconds`, default 30).

This suppresses duplicate **deliveries**. It does not make side effects exactly-once: the completion record and a payment, email or database write are not one transaction. A handler that fails, or a process that crashes, after the side effect and before the key is recorded runs again. Give such side effects their own idempotency, for example a key passed to the payment service or a unique constraint written in the same database transaction.

The store contract (`IdempotencyStore`), the key convention (`createIdempotencyKey`) and an in-memory store for single-process use are in `@holqa/core`; the local binding keeps keys durably in its state.

## Replay

Dead-lettered messages can be replayed under control: `holqa queue redrive` (and `LocalQueues.redrive`) redrives all, one, or the oldest *n* dead letters, can list them first with `--dry-run`, and keeps each message's lineage by default, so a message refused for its depth or budget is refused again. `--new-operation` starts a fresh root (depth 0, a new budget, and a new send time, so `maxEventAgeMs` counts from the redrive) for each message and keeps its correlation; use it after fixing the cause. Without it, a message refused for its age is refused again.

## Testing

`createTestApp` runs on the local binding, so every limit applies, and adds:

| Tool | Use |
| --- | --- |
| `events` option | Set runtime limits for the test, for example a small `maxEventsPerOperation`. |
| `maxInvocations` (default 10 000) | Bounds the invocations a test runs. Beyond it, `flush`, `advance` and `drain` throw `HOLQA_SIMULATION_BUDGET_EXCEEDED` naming the busiest handlers and the deepest chain. |
| `lineage(invocationId)`, `operation(rootId)` | Inspect publication chains and everything one root operation caused. |
| Virtual time, `failNext`, `duplicate`, `redrive` | Advance through delays and retries, inject failures and duplicate deliveries. |

## Related

- [Event safety guide](../guides/event-safety.md)
- [ADR 0026](../architecture/decisions/0026-event-safety-analysis-lineage-and-execution-guards.md)
- [Triggers and execution](triggers-and-execution.md)
- [Runtime reference](../reference/runtime.md#event-lineage-and-limits)
- [Diagnostic codes](../reference/diagnostic-codes.md)
- [`examples/event-safety`](../../examples/event-safety/README.md)
