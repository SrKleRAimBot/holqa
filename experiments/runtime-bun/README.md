# Bun runtime lifecycle experiment

> **Status:** Disposable M0 experiment — not part of the framework.

## Question

Can handlers be registered, invoked concurrently, cancelled, disposed and reloaded on Bun without corrupting runtime state?

**Answer: yes, with two caveats that shape `@holqa/runtime-bun`:** in-process cancellation is cooperative only, and Bun 1.3.13's module loader has failure modes that a reloading runtime must defend against. Both are workable. Neither invalidates the programming model.

## What was built

`@holqa/experiment-runtime-bun` depends only on `@holqa/core` and `@holqa/experiment-model`. It never imports the SDK; it works from descriptors (`getAppDescriptor`, `getHandlerDescriptor`, `bindApp`). The SDK and Zod are development dependencies, used only by the test fixtures.

| Module | Responsibility |
| --- | --- |
| `src/runtime.ts` | `createRuntime`, `load`/`reload` (serialized), `invoke`, `fetch`, `dispose`, `stats`, `idle`, `retired`. |
| `src/generation/*` | Handler discovery (`Bun.Glob`, sorted), module evaluation, registration validation, configuration validation, binding. |
| `src/hosts/in-process.ts` | Strategy A: re-import in the same thread after evicting `require.cache` entries under the app root. |
| `src/hosts/worker.ts`, `src/worker-entry.ts` | Strategy B: one Bun `Worker` per generation; invocations and resource operations cross by `postMessage`. |
| `src/drivers/*` | Runtime-owned in-memory queues (at-least-once, retries, dead letters) and buckets (object-created events). These survive reloads. |
| `src/semaphore.ts` | FIFO per-handler concurrency gate with cancellable waits. |
| `src/http.ts` | Route table (base path + template, static segments win) for `runtime.fetch(request)`. |
| `bench/measure.ts` | Load, reload, invocation and memory measurements (`bun run bench [reloads]`). |

### Lifecycle rules implemented

| Rule | Behaviour |
| --- | --- |
| Registration | Each load is validated as a whole. Checks: resource ID grammar and uniqueness, handler ID uniqueness, references to undeclared resources, at most one consumer per queue, and unknown descriptor protocol versions. If any check fails, nothing is registered. |
| Generation pinning | An invocation picks the current generation **after** it acquires its concurrency slot, and never moves. |
| Reload | The next generation is parsed, evaluated, validated, configured and bound before an atomic swap. The old generation drains (up to `drainMs`), any remaining work is cancelled, and then it is disposed. Reloads are serialized. A failed reload returns `HOLQA_RELOAD_FAILED` followed by its causes, and the old generation keeps serving. |
| Concurrency | One semaphore per handler ID, shared by all generations, so a limit holds across reloads. A reload can change the limit. Lowering it never revokes held slots. |
| Cancellation | The caller's signal, a timeout, generation retirement and runtime disposal all abort `context.signal`. The caller's promise settles at once with `HOLQA_INVOCATION_CANCELLED` (or `HOLQA_RUNTIME_DISPOSED` on disposal). |
| Orphans | A cancelled handler that is still running is counted in `stats().orphaned` **and keeps its concurrency slot** until its code finishes, so cancellation can never push concurrency above the declared limit. |
| Disposal | Idempotent and shared by concurrent callers. New work is rejected immediately (`HOLQA_RUNTIME_DISPOSED`). In-flight work gets `graceMs`, is then cancelled, and every generation is disposed. |
| Configuration | Validated at every load against each entry's schema; variable defaults applied. Invalid secrets are reported by name only (`HOLQA_CONFIG_INVALID`): neither the value nor the schema's issue messages appear. |
| Queues | At-least-once: failures are redelivered with an incremented `attempt` up to `maxAttempts` (default 3), then dead-lettered when `deadLetter` is declared, or counted as dropped otherwise. Validation failures are not retried. Messages that hit a disposed runtime or a missing consumer stay pending. Messages are stored JSON-encoded. There is no ordering, no backoff and no persistence. These are deliberately no stronger than a production binding. |
| Buckets | Each `put` notifies matching `prefix` handlers once. Failures are recorded, not retried. A production store may duplicate or reorder events. |

## Method

All numbers below come from real runs on Bun 1.3.13, darwin/arm64. They are machine-dependent.

- `bun test` (45 tests) runs the same lifecycle suite against both strategies. Fixtures live in `tests/fixtures/basic` and use the SDK prototype with Zod. Tests that rewrite files work on copies in `experiments/runtime-bun/.tmp/`.
- Ordering-sensitive tests run in-process and use latches shared through `globalThis` (`tests/fixtures/basic/latches.ts`). Worker tests use short sleeps and assert only invariants that cannot depend on timing.
- Stress, in-process: 48 concurrent invocations of a `concurrency: 2` consumer, interleaved with 6 reloads, 9 caller cancellations, handlers that ignore aborts, and out-of-order releases.
- Stress, worker: 40 invocations with mixed timeouts and abort-ignoring handlers, interleaved with 4 reloads.
- `bun bench/measure.ts 50` and `bun bench/measure.ts 200`.

## Results

### Invariants (all pass)

Each invocation settled exactly once. In-flight and waiting counters returned to zero, and `orphaned` returned to zero once the handlers finished. Peak concurrency never exceeded the declared limit, including orphans. No handler started in a disposed generation. Each generation had exactly one module evaluation and never shared state with another. `completed + failed + cancelled` equalled the number of invocations. Every replaced generation ended `disposed`. Results came only from loaded versions.

### Measurements

| Strategy | First load | Reload (median) | Invoke (median, sequential) | 2000 concurrent invokes | Heap growth, 50 / 200 reloads | RSS growth, 50 / 200 reloads |
| --- | --- | --- | --- | --- | --- | --- |
| In-process (A) | 17.8–19.1 ms | 1.1 ms | 2.7 µs | 9.1–9.8 ms | 3.1 / 9.5 MiB | 16.2 / 45.4 MiB |
| Worker (B) | 19.6–20.4 ms | 17.5–17.6 ms | 18.3–18.6 µs | 14.7–15.3 ms | 0.7 / 1.7 MiB (main thread only) | 98.6 / 233.8 MiB |

Notes:

- An earlier run showed 35 MiB of in-process heap growth over 200 reloads. The cause was this runtime keeping disposed generations' hosts, which pinned their module graphs. Releasing the host on disposal fixed it. The remaining roughly 47 KiB per reload is retained inside Bun, probably module records kept by the ESM loader; this was not investigated further.
- Workers: terminated workers do not return their memory to the operating system within the measurement window, about 1.2–2 MiB RSS per reload. Whether that is allocator retention or a leak was not determined.

## Findings

### Fundamental limitations (confirmed)

1. **No in-process hard cancellation.** JavaScript cannot stop a running async function. Handlers that ignore `signal` keep running after their caller sees `HOLQA_INVOCATION_CANCELLED`. The runtime can only make this observable (`orphaned`), keep the concurrency slot held, and unbind the generation on disposal: later handle use then fails with `HOLQA_RUNTIME_NOT_BOUND`. Only a Worker (`terminate()`) or a process boundary gives a hard stop. The handler contract must say that honouring `signal` is required, not optional.
2. **Bun's module cache is not a reload API.**
   - `import(path + "?v=N")` re-evaluates only that module. Transitive modules, including `infra.ts` and shared state, stay cached and shared (pinned by `tests/generation/load-graph.test.ts`).
   - `delete require.cache[path]` also evicts ES modules in Bun 1.3.13: old instances keep working and the next import evaluates afresh. The Bun docs only call `require.cache` "fully implemented" Node compatibility; ESM eviction is observed, undocumented behaviour, and the strategy depends on it.
   - **Parse failures poison the registry.** After a module fails to parse, any later `import()` of it, direct or transitive and in the same module graph, **never settles**, even after the file is fixed and evicted. A thrown evaluation error recovers; a missing module is cached as a failure. In a single generation, the first handler that imports a broken shared module gets an error, and the second hangs. This affects workers too.
   - Mitigations, all implemented and tested:
     - every file under the app root is parsed with `Bun.Transpiler` before anything is imported;
     - handler modules carry a per-generation query string (in-process);
     - every import races a timeout, so one bad edit cannot block the reload chain.
   - `infra.ts` itself must **not** be cache-busted. Handlers import it by its plain path, so a busted copy would be a second, unbound application instance.
3. **Ambient handles require one application instance per generation.** Handles imported from `infra.ts` find their runtime through the application descriptor's binding slot. This works because each generation evaluates its own `infra.ts`, and old and new generations stay bound side by side while the old one drains. A runtime that reused one module instance across generations could not bind them independently. Per-invocation context for ambient calls (trace IDs, cancelling a `send`) would need `AsyncLocalStorage` in the runtime; that was not prototyped.
4. **Workers isolate fully, at a fixed cost.** Per generation: about 17 ms to reload and about 16 µs extra per invocation in this measurement (structured clone plus a message round trip). Resource operations also cross the boundary, and memory is not returned promptly after `terminate()`. Values that cannot be structured-cloned, such as functions or class instances in results, fail at the boundary.

### Design findings

- The runtime needs only model descriptors. The `runtime-bun → core` boundary holds, provided handler, resource and binding contracts move into `@holqa/core`.
- Queues and buckets must be runtime-owned rather than generation-owned. Messages sent by an old generation are consumed by the new one, as the reload tests confirm.
- Generation numbers count load attempts, so a failed reload consumes a number. Tools should not assume consecutive numbers.
- `@types/bun` resolves to 1.4.3 while the pinned runtime is 1.3.13. The types document APIs the runtime lacks, for example `Bun.ModuleGraph`, an isolated module graph that would be a third reload strategy once Holqa can require a Bun version that has it.
- tsdown with `platform: "node"` emits `.mjs`/`.d.mts` by default, which does not match the repository's `./dist/index.js` exports. This package sets `fixedExtension: false`.

## Recommendation

- **`holqa dev`:** use the **worker strategy (B)**. Reload correctness (full isolation, hard stop of runaway handlers, no dependence on undocumented cache eviction) matters more than 17 ms per reload. Keep the syntax pre-check and import timeouts; workers need them too. Restart the worker process periodically, or every N reloads, to bound RSS.
- **Production `@holqa/runtime-bun`:** run a single generation in-process. Deployments replace the process, so in-process reload is unnecessary. Use process or worker boundaries only where hard cancellation or isolation is a requirement.
- Keep: generation pinning after slot acquisition; orphans holding slots; runtime-owned resource drivers; whole-load registration validation; secret-safe configuration diagnostics.
- Make honouring `context.signal` part of the documented handler contract, and surface `orphaned` in `holqa dev` output.

## Requested changes outside this package

- **SDK `queue.send` should transmit the input, not the validated output.** The prototype validates and then forwards the schema's output, and the consumer validates again. With a transforming schema (for example `z.string().transform(Number)`) the consumer validates an output against the input schema and fails. Validate on send but transmit the original (or an explicitly encoded) value; encoding across process boundaries needs its own decision (ADR 0006, now superseded by ADR 0016). **Resolved during M0:** the prototype SDK now forwards the input form ([ADR 0016](../../docs/architecture/decisions/0016-schema-adapters-and-conversion-fidelity.md), decision 6).
- **Model: a generic handler-failure code** (for example `HOLQA_HANDLER_FAILED`) for 500 responses and dead-letter reasons. Today `fetch` returns 500 with an empty diagnostics list rather than leak handler errors.
- **Model: move `HandlerInfo`/`ResourceInfo`-style JSON metadata into the contract,** so runtimes and the compiler share one shape.
- **Repository:** ESLint's `dot-notation` autofix rewrites `record["key"]` to `record.key`, which then fails `noPropertyAccessFromIndexSignature`. The tests work around it with a helper (`tests/support/wait.ts#counter`), but the root ESLint config should align with the tsconfig.

## What is disposable

Everything in this directory. Carry the findings, the lifecycle rules and the test scenarios forward into `@holqa/runtime-bun` and `@holqa/local`, not the code.
