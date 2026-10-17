# 0015. Runtime generations and reload

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

> **Implementation status:** Accepted design, validated by the disposable [Bun runtime lifecycle experiment](../../../experiments/runtime-bun/README.md) on Bun 1.3.13. `@holqa/runtime-bun`, `@holqa/local` and `holqa dev` are not implemented.

## Context

Handlers import typed handles from `infra.ts`, and handles reach the runtime through a binding on the application instance ([ADR 0013](0013-descriptor-protocol-in-core.md)). The local environment must reload code quickly without corrupting runtime state: in-flight invocations, concurrency limits, queued messages and stored objects.

M0 measured two strategies, with 45 tests including two stress tests that interleave concurrent invocations, cancellations and reloads.

| Strategy | Reload (median) | Invoke (median) | Heap / RSS growth, 200 reloads |
| --- | --- | --- | --- |
| In-process, with module-cache eviction | 1.1 ms | 2.7 µs | 9.5 MiB / 45 MiB |
| One Worker per generation | 17.5 ms | 18.5 µs | 1.7 MiB (main thread) / 234 MiB |

The experiment confirmed three hard facts:

- JavaScript cannot stop a running async function in-process.
- Bun's module cache is not a reload API. Query-string cache busting re-evaluates only the entry module. ES module eviction through `require.cache` is undocumented behaviour. After a module fails to parse, later imports of it never settle.
- Ambient handles work only if each generation evaluates its own `infra.ts`.

## Decision

1. The runtime executes **generations**. A generation is one evaluated module graph (`infra.ts` plus discovered handler modules) with its own application instance, registry and binding.
2. A load or reload is validated as a whole: identifiers, references, one consumer per queue, the descriptor protocol and configuration. The next generation is evaluated, validated and bound before an atomic swap. On any failure, the reload reports `HOLQA_RELOAD_FAILED` and the previous generation keeps serving. Reloads are serialized.
3. An invocation is pinned to the current generation when it acquires its concurrency slot. Replaced generations drain for a bounded time; remaining work is then cancelled and the generation disposed.
4. Concurrency limits are per handler identifier and shared across generations. A cancelled handler that is still running is counted as **orphaned** and keeps its slot until it finishes.
5. Cancellation (caller signal, timeout, retirement, disposal) aborts `context.signal` and settles the caller at once. Honouring `signal` is part of the handler contract, because only a Worker or process boundary can stop a handler that ignores it.
6. Resource drivers (queues, buckets, schedulers) are owned by the runtime, not by a generation, so messages and objects survive reloads.
7. `holqa dev` uses **one Worker per generation**. It parses every application file before importing, applies a timeout to every import, and restarts the worker process after a bounded number of reloads to cap memory. Production runtimes run a single in-process generation, because deployments replace the process.

### Relation to ADR 0007

[ADR 0007](0007-separate-compiler-and-runtime.md) decision 2 stands: in production, the runtime executes the compiler's bundled artifacts and treats the manifest as the contract. Evaluating source modules and validating the graph at load time is a development-mode (`holqa dev`) and test concern. That validation must be the same contract-layer function the compiler uses ([backlog](../../milestones/m0/backlog.md) HB-33), never a second implementation; the M0 prototypes duplicated it and diverged.

## Consequences

### Positive

- Reloads cannot leak state between versions, and a broken edit never takes down the running version.
- Runaway handlers can be stopped in development.
- The same lifecycle rules apply to local development, tests and production.

### Negative

- About 17 ms per reload and about 16 µs per invocation for the Worker boundary, and results must be structured-cloneable.
- Terminated workers do not return memory promptly, so periodic process restarts are required.
- The design depends on defending against Bun module-loader behaviour (parse-failure hangs) that may change between Bun versions. Each Bun upgrade must re-run the lifecycle suite.

### Revisit when

- Bun ships a documented isolated module graph API (the `@types/bun` 1.4 typings describe `Bun.ModuleGraph`), which could replace Workers for isolation.
- Per-invocation context for ambient handle calls is designed ([backlog](../../milestones/m0/backlog.md) HB-32).

## Alternatives considered

### In-process reload with `require.cache` eviction

The fastest option (1.1 ms), but it relies on undocumented ESM eviction behaviour and cannot stop runaway handlers. Kept as a fallback strategy, not the default for `holqa dev`.

### Query-string cache busting

Rejected. Measured to re-evaluate only the entry module, so `infra.ts` and shared modules keep stale code and shared state.

### A new process per reload

Not measured. It would give the strongest isolation at a higher start-up cost. It remains an option if Worker memory retention proves unmanageable.

## Related

- [Bun runtime lifecycle experiment](../../../experiments/runtime-bun/README.md)
- [Local development](../../concepts/local-development.md)
- [Triggers and execution](../../concepts/triggers-and-execution.md#execution-model)
- [ADR 0002: Bun as the primary runtime](0002-bun-as-primary-runtime.md)
