# 0026. Event safety: static cycle analysis, event lineage and execution guards

- **Status:** Proposed (implemented)
- **Date:** 2026-10-20
- **Deciders:** Holqa maintainers
- **Refines:** [ADR 0024](0024-event-delivery-sources-and-local-drivers.md) decision 3 (deliveries that end at once without retries)

## Context

Event-driven handlers can cause unbounded work: a queue consumer that sends to its own queue, two consumers that trigger each other, an object-created handler that writes into the prefix it watches, or a handler that fans out into many messages per message. At-least-once delivery makes it worse, because retries and duplicates run handler code again.

Holqa knows more than a general-purpose framework: the compiler evaluates the application's declarations and handler modules ([ADR 0014](0014-evaluation-based-manifest-extraction.md)), and every invocation runs through one dispatcher ([ADR 0023](0023-common-invocation-engine-and-http-rpc-execution.md)) on bindings with delivery sources ([ADR 0024](0024-event-delivery-sources-and-local-drivers.md)). Before this decision, the compiler recorded which resources *trigger* handlers but not which resources handlers *publish* to, and runtime traces carried a correlation and a causation identifier but no depth or root operation.

Constraints:

- The compiler cannot prove that a cycle terminates: a handler may requeue work until a terminal state, which no TypeScript analysis can decide in general.
- The compiler must stay runtime-neutral and dependency-free; it already evaluates modules and receives their sources only for diagnostic locations.
- Aggregate limits across workers need coordinated, atomic state. A binding that cannot provide it must not claim to enforce them ([infrastructure neutrality](../../concepts/infrastructure-providers.md)).
- Manifest version 1 must not change shape without a new version; handler code changes must not change the manifest's fingerprint.
- Exactly-once side effects are not achievable in general: a deduplication record and an external side effect are not transactional.

## Decision

1. **An event dependency graph, produced beside the manifest.** `compileApplication` builds an `EventAnalysis`: resource and handler nodes, consumption edges (triggers) and publication edges, plus the publication calls it could not resolve. Publications come from a lexical scan of each handler's code combined with the evaluated values of the modules it imports: `resources.orders.send(...)` is resolved by reading `resources.orders` from the evaluated module and checking that it is a queue handle. The scan follows `const` aliases, destructuring, imports, helper functions (up to four calls deep, in the same module or another application module) and handles passed to functions. Every edge has a certainty: `known`, `potential` (through a helper, a handle passed to a function, or an object key whose prefix analysis cannot compare) or `unknown` (unresolved). Object writes are matched against prefix filters. The analysis is not part of the manifest; `holqa inspect --cycles` prints it.
2. **Cycles are warnings, not errors.** Strongly connected components of the handler graph become `HOLQA_EVENT_CYCLE` diagnostics with a representative path and source location: warnings for cycles of known publications, information for potential ones. Builds still succeed.
3. **Declarations where analysis is not enough.** A handler's `events` option declares publication targets the scan cannot see (`publishes`), an intentional cycle with a justification (`cycle`) and limits (`maxDepth`, `maxPublications`). A justified handler's cycles are reported as allowed; other cycles, including ones elsewhere in the same component, are still reported, and runtime limits still apply.
4. **Event lineage in every trace.** `DeliveryTrace` gains `rootId` and `depth`. A root invocation (an HTTP request, a scheduled run, a direct invocation, a delivery that carries no trace) is its own root at depth 0; an event it publishes carries depth 1, and so on. Retries, redeliveries and duplicates keep their lineage. The root is always assigned by the runtime, never taken from a caller, so requests that share a caller's `x-correlation-id` never share budgets. Handlers see their lineage as `context.lineage`.
5. **Runtime execution guards with terminal outcomes.** Every runtime enforces, in process, a maximum depth (default 16, checked against the receiving handler's limit) and a maximum number of events per invocation (default 1000), counting only events a registered handler receives. A maximum event age applies when the binding reports when a delivery was sent. A per-operation budget (`maxEventsPerOperation`) is enforced only with a binding that provides an atomic `OperationBudgetStore`; a runtime configured with one refuses to start on a binding without it. A refused publication throws in handler code; a delivery stopped by a guard, or whose handler failed after a refusal, is dead-lettered or discarded at once instead of being retried.
6. **Idempotency as an explicit, limited contract.** `IdempotencyStore` (claim, renew, complete, release, with leases and retention) is part of the binding contract. A queue consumer or object event handler may declare `idempotency`; the SDK then claims the key (default: the message or event identifier) before the handler runs, renews the claim while it runs, and skips deliveries whose key completed. Holqa documents this as duplicate-delivery suppression, never as exactly-once side effects.
7. **The local binding implements both stores** in its SQLite state (format 3), shared by every process that uses the state directory, and offers controlled redrive (`limit`, a dry run, and `newOperation` to start a fresh lineage). `@holqa/testing` bounds simulations with `maxInvocations` and reports the deepest chain when a test runs into it.

The decision is implemented in `@holqa/core`, `@holqa/sdk`, `@holqa/compiler`, `@holqa/runtime-bun`, `@holqa/local`, `@holqa/testing` and `@holqa/cli`, and exercised by `examples/event-safety`.

## Consequences

### Positive

- Direct and indirect cycles are found before code runs, with paths and locations, without a TypeScript compiler dependency.
- Runaway chains stop at a bounded depth with a structured, terminal outcome instead of retry loops.
- Intentional cycles are documented in code, next to their justification, and stay bounded.
- Budgets are only enforced where they can be enforced; nothing is claimed for bindings that cannot keep it.

### Negative

- The scan is heuristic. Calls on parameters, computed receivers, class members, `let` variables reassigned later, and code outside the application root are unresolved; code in any branch counts as a publication. Unknown publications are listed, not guessed.
- Default limits change behavior: a chain deeper than 16 hops or an invocation publishing more than 1000 events is now refused unless a limit is raised.
- Analysis may import application modules that the handler modules import but that were not loaded yet (for example only for their types), which runs their code; this is the same trust assumption as the rest of analysis.
- Idempotency adds a store round trip per delivery for handlers that opt in, and a duplicate that finds its key held by a running delivery counts as a failed attempt.
- Declared handler requirements (`idempotency`, event limits) are not visible in manifest version 1; whether a binding provides the stores they need is checked only when the runtime starts.
- Depth limits and operation budgets only span hops through bindings that store lineage; a delivery without it starts a new root at depth 0.

### Revisit when

- A TypeScript-aware analysis becomes affordable at build time (accurate symbol resolution through parameters and generics).
- A binding for external infrastructure needs per-operation budgets; its store must be atomic across the service's consumers.
- A future manifest version records declared event policies.

## Alternatives considered

### Fail builds on cycles

Rejected: legitimate cycles (retry with state, polling until ready) exist, and the compiler cannot prove termination. Failing would push users to disable analysis.

### Use the TypeScript compiler API for analysis

Deferred: accurate, but adds a large dependency, slows inspection to a type check, and still cannot decide termination. The evaluated-value approach resolves the common patterns and labels the rest.

### Record publications in the manifest

Rejected for manifest version 1: publications derive from handler code, so every implementation change would change the manifest and its fingerprint, and the format would need a new version.

### Enforce operation budgets in memory everywhere

Rejected: with several workers or processes an in-memory counter undercounts, so the budget would be a promise the runtime does not keep. The capability is explicit instead.

## Related

- [Event safety](../../concepts/event-safety.md) and the [event safety guide](../../guides/event-safety.md)
- [Runtime reference](../../reference/runtime.md#event-lineage-and-limits)
- [Local environment](../../reference/local.md)
- [CLI reference](../../reference/cli.md)
- [ADR 0014](0014-evaluation-based-manifest-extraction.md), [ADR 0023](0023-common-invocation-engine-and-http-rpc-execution.md), [ADR 0024](0024-event-delivery-sources-and-local-drivers.md)
