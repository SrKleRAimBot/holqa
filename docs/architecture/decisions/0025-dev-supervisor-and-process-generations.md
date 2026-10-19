# 0025. A development supervisor with one process per generation

- **Status:** Proposed
- **Date:** 2026-10-19
- **Deciders:** Holqa maintainers
- **Supersedes in part (once accepted):** [ADR 0015](0015-runtime-generations-and-reload.md) decision 7 (one Worker per generation for `holqa dev`), and it narrows decision 2 (see decision 2 below). The rest of ADR 0015 stands.
- **Refines:** [ADR 0023](0023-common-invocation-engine-and-http-rpc-execution.md) (log fields), [ADR 0024](0024-event-delivery-sources-and-local-drivers.md) (delivery traces, subscription cleanup).

> **Implementation status:** Proposed, and already implemented so the design can be reviewed against working code; until it is accepted, ADR 0015 decision 7 remains the accepted design that the implementation deviates from. Implemented in `@holqa/cli` (`holqa dev`, the operation commands, `holqa state`, `holqa doctor`), `@holqa/runtime-bun` (trace propagation and emitted events), `@holqa/local` (stored traces, state format 2) and `@holqa/testing` (`createTestApp`). Module-level hot-swapping and Worker generations are **Planned**. See the [local development guide](../../guides/local-development.md) and the [CLI reference](../../reference/cli.md).

## Context

[ADR 0015](0015-runtime-generations-and-reload.md) accepted generations: each reload evaluates a fresh module graph with its own application instance, and a failed reload never takes down the running version. Its decision 7 chose one Worker per generation for `holqa dev`, measured at about 17 ms per reload, with periodic process restarts to cap memory that terminated Workers do not return.

Building `holqa dev` on the runtime of [ADR 0023](0023-common-invocation-engine-and-http-rpc-execution.md) and the local drivers of [ADR 0024](0024-event-delivery-sources-and-local-drivers.md) added constraints:

- A generation owns delivery workers and a scheduler subscription. Two generations that consume the same local state at once deliver a message to two consumers and fire a schedule twice. Overlapping generations are therefore not safe, even briefly.
- The local environment opens a SQLite database and object files, and keeps timers. Disposing of all of that reliably inside a long-lived process is exactly the lifecycle problem the brief asked to get right before attempting hot module replacement.
- Bun 1.3.13 has no documented API to unload modules ([ADR 0015](0015-runtime-generations-and-reload.md)), and the memory of terminated Workers must be capped by restarting the process anyway.
- The analysis process of [ADR 0014](0014-evaluation-based-manifest-extraction.md) already evaluates the application in a fresh process with an allowlisted environment, in roughly 50 to 150 ms for the examples.

Developers also need to see which event triggered a handler and what it emitted, and agents need machine-readable output and stable exit codes from every command.

## Decision

1. **One process per generation.** `holqa dev` is a supervisor process. Each generation is a separate Bun process that loads the compiled application (`loadCompiledApplication`), creates a local environment on the shared state directory and runs one runtime. The supervisor owns the session's HTTP address and forwards requests to the serving generation, so the address is stable across reloads; requests that arrive during a swap wait for the next generation for a bounded time.
2. **Two-phase swap.** A reload analyzes the application and writes the build. The new generation then *prepares*: it loads every module, creates its runtime, validates configuration and checks capabilities and trigger delivery, while the previous generation keeps serving. Any failure up to this point is reported as `HOLQA_RELOAD_FAILED` with its causes, and the previous generation keeps serving. Only after a successful preparation is the previous generation stopped gracefully (in-flight invocations finish, deliveries are settled or released), and the new one *activated*: it starts consuming and serving. At most one generation consumes queues, events and schedules at any time; a session also locks its state directory, so two sessions never share local state. A failure during activation leaves no generation running until the next change; this is rare, because preparation covers loading, configuration and capabilities. This narrows ADR 0015 decision 2, under which the previous generation keeps serving after any failure.
3. **Classified changes.** Every reload is classified by comparing manifests: `implementation` (the manifest is unchanged: only code changed), `handlers`, `resources` (including configuration), `environment` (only `.env` files changed: no analysis), or `initial`. Every kind restarts the generation process; none recreates local state, which lives in the state directory and survives every change, including removed resources. Changes are classified against the manifest of the serving generation, not against a build that failed to start. One exception to "nothing is removed": each activated generation removes the object event subscriptions of handlers that no longer exist (`retainSubscriptions`), so events stop piling up for them; deliveries already recorded are kept, and a handler that disappears briefly (for example while it is commented out) misses the events written meanwhile. Changed queue message and HTTP request and response contracts are compared with the compatibility checker of [ADR 0021](0021-schema-contracts-wire-payloads-and-compatibility.md) and reported, not enforced, because messages already in a local queue were written with the previous contract. Contract errors that the compiler rejects (for example a consumer whose schema no longer matches its queue) fail the reload.
4. **Sessions and operations.** A session records itself in `.holqa/dev/session.json` next to the application: its process, address and a random bearer token, readable by its owner only. A second session for the same application is refused with `HOLQA_DEV_SESSION_ACTIVE`. The operation commands (`invoke`, `queue send`, `storage put`, `cron run`, `state`) send their work to the session's control endpoint when a session runs for the same state directory, so they share its runtime and logs; otherwise they start a generation process in `once` mode for the one operation, with its own build directory, which never consumes queued work that a later session should receive. While a session lives, an operation never falls back to another process: a session that does not answer is reported as `HOLQA_LOCAL_OPERATION_FAILED`, because the operation may already have run.
5. **Delivery traces.** The runtime attributes resource operations to the running invocation with `AsyncLocalStorage`, passes `{ correlationId, causationId }` to drivers through an optional `DriverOperationContext`, and records what the invocation emitted. Bindings that can store the trace return it as `LeasedDelivery.trace`, and the receiving invocation joins the trace: same `correlationId`, `causationId` set to the sending invocation. The local binding stores traces (state format 2). Bindings that cannot store them omit them; delivery is unaffected.
6. **Machine-readable output.** With `--json`, `holqa dev` writes one JSON event per line, and every other command writes one JSON document to standard output and, on failure, `{"diagnostics":[...]}` to standard error. Exit codes stay `0`, `1` and `2`.

The development supervisor applies to `holqa dev` and the operation commands. Production runtimes still run one in-process generation, because deployments replace the process ([ADR 0015](0015-runtime-generations-and-reload.md)).

## Consequences

### Positive

- No module state, listener, timer, database handle or consumer survives a reload, because the process that held it exits. Long sessions do not accumulate memory or duplicate consumers, and the Worker memory cap of ADR 0015 is unnecessary.
- A broken edit never replaces a working generation: the old one keeps serving until the new one has loaded and checked everything that commonly fails.
- Handlers see one trace across HTTP requests, queue messages and object events, and every finished invocation lists what it emitted.
- The same operation code runs inside a session and in standalone processes, so the CLI behaves the same whether or not `holqa dev` runs.

### Negative

- A reload costs an analysis process and a generation process start, roughly 100 to 300 ms for the examples, compared with about 17 ms for a Worker. Requests wait during the swap.
- Handlers that ignore their abort signal delay the swap until the stop grace period ends, after which the old process is killed.
- Requests are proxied once more than with an in-process server; the generation rebuilds each request with the session's public origin, so handlers see the address the client used.
- A failure during activation (after the previous generation stopped) leaves no generation running until the next change.

### Revisit when

- Bun documents a module graph API that can unload modules, or a Vite module runner proves able to dispose of resources reliably; module-level hot-swapping can then be explored for `implementation` changes, keeping the process boundary for the others.
- Reload latency matters more than the isolation, for example for very large applications.

## Alternatives considered

### One Worker per generation (ADR 0015 decision 7)

Faster reloads, but terminated Workers keep memory, the SQLite handles and timers of the local environment would need careful disposal in the long-lived process, and a Worker generation cannot overlap with the next one either, so the speed advantage is smaller than measured in M0. Deferred.

### In-process reload with module-cache eviction

Relies on undocumented Bun behaviour and cannot stop runaway handlers (ADR 0015). Rejected for now.

### Start the next generation before stopping the previous one

Zero-downtime swaps, but two generations would consume the same queues and schedules at once and duplicate deliveries and runs. Rejected; preparing without consuming gives most of the benefit.

### Operation commands that always run standalone

Simpler, but invocations would not share the session's in-memory state or appear in its logs, and `cron run` would not record runs through the session's scheduler. Rejected in favour of attaching to the session when it runs.

## Related

- [Local development guide](../../guides/local-development.md)
- [CLI reference](../../reference/cli.md)
- [Local development](../../concepts/local-development.md)
- [ADR 0015: Runtime generations and reload](0015-runtime-generations-and-reload.md)
