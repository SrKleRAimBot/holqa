# 0028. Hot handler replacement inside a development generation

- **Status:** Proposed
- **Date:** 2026-10-20
- **Deciders:** Holqa maintainers
- **Refines (once accepted):** [ADR 0025](0025-dev-supervisor-and-process-generations.md) decision 3 (every change restarts the generation process) for changes that only touch handler code. [ADR 0015](0015-runtime-generations-and-reload.md) decisions 3 and 4 (pinning and shared concurrency limits) are applied to handler versions inside one runtime.

> **Implementation status:** Proposed, and already implemented so the design can be reviewed against working code. Implemented in `@holqa/runtime-bun` (the versioned handler registry, `Runtime.replaceHandlers`, per-version scope views), `@holqa/cli` (reload planning, in-process replacement, the development dashboard) and `@holqa/testing` (recording, replay, causal chains). Module unloading, worker isolation and type checking during reloads are not implemented. See the [local development guide](../../guides/local-development.md#how-reloads-work).

## Context

[ADR 0025](0025-dev-supervisor-and-process-generations.md) made every reload a new generation process. That is dependable, but each change costs an analysis, a process start, loading every module and opening the local state, and requests wait during the swap. Most edits during development change only the body of a handler or a helper it imports.

A faster path must not weaken what the restart path guarantees:

- At most one consumer per queue, schedule and event subscription, at all times.
- Work that is already running when a file changes finishes under the code it started with, or reaches its configured time limit.
- A broken edit never produces a partially updated application; the last working code keeps serving, and the developer can see that it is stale.
- Resources (timers, listeners, connections) created by replaced code do not accumulate.

Facts established on Bun 1.3.13 while designing this:

- Bun's module registry cannot unload modules, and query-string cache busting re-evaluates only the entry module ([ADR 0015](0015-runtime-generations-and-reload.md)). Fresh copies of a module graph therefore have to be produced some other way, and old copies stay in memory.
- `Bun.build` can bundle handler modules into a new directory with code splitting. An external import keeps its original specifier, so imports of modules that must stay shared have to be rewritten to absolute paths before bundling. Re-exporting a shared module through a proxy module does not work: Bun 1.3.13 miscompiles `export *` from an external module.
- A bundle without top-level `await` can be evaluated synchronously with `require` (`import.meta.require`). During that call no other JavaScript runs, so every timer, listener or server created meanwhile was created by the bundle's top-level code.
- Bun's `--hot` mode re-evaluates changed modules but keeps global state and knows nothing about queue consumers or in-flight invocations, so it is not a basis for this design. Vite's module runner was not adopted either; it would add a dependency for the same graph-and-invalidate step.

## Decision

1. **The runtime owns a versioned handler registry.** A handler's definition, schemas and concurrency limit belong to the handler; its implementation belongs to a version. `Runtime.replaceHandlers(registrations)` installs new implementations for several handlers at once, atomically, as one new registry version. It refuses (and replaces nothing) when a registration names an unknown handler, names one twice, or changes a definition (trigger, event policy, idempotency, schema roles): `HOLQA_HANDLER_REPLACEMENT_INVALID`. Schema contents are checked by the caller, through the compiler.
2. **Executions are pinned when they get their slot.** An invocation runs the implementation that is current when it acquires its concurrency slot, and keeps it until its code finishes, including as an orphan after a timeout. Unlike ADR 0015 decision 3, a retiring version has no drain limit of its own: its executions are bounded by their invocation time limits, and a version whose handler ignores its signal (or runs without a time limit) stays retiring until that code finishes. Transports, delivery workers, schedule subscriptions and concurrency limits are untouched by a replacement, so a queue keeps exactly one consumer.
3. **Versions retire and release their scope.** A replaced version retires when its last execution finishes. Each version receives its own view of the application scope: values are shared, but the view's `signal` aborts at retirement, and scoped values that only retired versions used are disposed of then. Application authors do not write disposal code for handler modules; `scoped({ create, dispose })` and `context.scope.signal` are the explicit hooks for resources that outlive one invocation.
4. **`holqa dev` plans every reload.** After the analysis, the supervisor builds the import graph of the application's own modules (static imports, re-exports, `require` and literal dynamic imports, within the application root) and replaces handlers in place only when all of these hold: the manifest and the entry point map are unchanged; every changed file is reachable from a handler module but not from the application module; no dependency manifest, lockfile, `tsconfig` or `bunfig` changed; no affected module contains the comment `holqa:restart-on-change`; and the process has made fewer than 50 replacements. Handler modules that share any application module with an affected one are rebuilt with it, so module state stays shared by exactly the handlers that shared it before. Every other change restarts the generation process as in ADR 0025, and the reason is reported.
5. **Replacement inside the generation.** The generation bundles the affected handler modules into `.holqa/dev/hot/<generation>/<n>`, keeps the application module, its imports, packages and files outside the root as the running instances, and evaluates the bundle synchronously while observing timers, process and global listeners, `Bun.serve`/`listen`/`connect`/`spawn`, workers, WebSockets and new global names. Any such effect is undone and the replacement is refused, because the previous copy's effects cannot be cleaned up in place: the supervisor restarts instead. Only after the whole bundle evaluated cleanly is `replaceHandlers` called.
6. **Broken code never runs.** A change that fails analysis, bundling or evaluation leaves the running implementations in place. The session marks itself stale (`stale: true` on failure events, a `STALE` line in the terminal, a banner on the dashboard), and the stale files are planned again with every later change until one applies them.
7. **Contracts and queued messages.** Contract changes still restart the process (ADR 0025 decision 3). When a queue's contract changed, the new generation validates the messages already waiting in it against the new contract and logs `HOLQA_QUEUED_MESSAGE_INCOMPATIBLE` with counts and message identifiers. Nothing is changed or removed.
8. **Restart remains the fallback.** `holqa dev --no-hot` restarts on every change. A process is also restarted after 50 replacements, because old module copies cannot be unloaded.
9. **A development dashboard and replay tools are presentation and test layers.** `holqa dev` serves a read-only dashboard at `/_holqa/dashboard` on loopback addresses only, built from the supervisor's status, the `state` operation, the session's logs and the local telemetry store; it stores nothing and never shows message payloads. `@holqa/testing` records what handlers received (`recording()`), replays it deterministically through the virtual clock (`replay()`), and lists causal chains step by step (`chain()`). Replays reproduce external side effects only through explicit mocks or fixtures.

## Consequences

### Positive

- A handler edit applies in tens of milliseconds after the analysis, without restarting the process, reopening local state or re-registering consumers. Requests are not held during a replacement.
- In-flight work completes under the code it started with, and every invocation log of a replaced implementation names its `handlerVersion`.
- The restart path of ADR 0025 is unchanged and remains the answer whenever safety cannot be shown.

### Negative

- Each replacement keeps the old module copies in memory until the process restarts; the 50-replacement limit bounds this.
- Side-effect detection covers the observed APIs, during synchronous evaluation only. Effects started later by top-level asynchronous code (a top-level promise chain or an immediately invoked async function that awaits first) are not observed and accumulate with every replacement. Modules with top-level `await` cannot be evaluated synchronously at all; they always restart.
- Side-effect detection covers the observed APIs only. Connections opened at module top level by a library (for example through `node:net`) are not detected; such modules should create them in `scoped` values, or carry the `holqa:restart-on-change` comment.
- Static import analysis cannot follow computed dynamic imports. Files it cannot attribute to a handler module restart the process.
- Module state in replaced handler modules resets on every replacement, as it does on a restart.
- The bundler plugin rewrites import specifiers with a regular expression after Bun's import scanner found them; unusual formatting that the expression misses is detected and leads to a restart, not to a wrong replacement.
- Type errors are not checked during reloads; `holqa dev` evaluates code as Bun does.

### Revisit when

- Bun documents a module graph API that can unload modules: the replacement limit could go.
- A Vite module runner proves useful for applications that already use Vite for the backend.
- Worker isolation ([ADR 0015](0015-runtime-generations-and-reload.md) decision 7) is implemented: runaway handlers of retired versions could then be stopped.

## Alternatives considered

### Bun `--hot`

Re-evaluates changed modules in place but keeps global state, duplicates timers and listeners, and cannot tell which handler version an in-flight invocation runs. Rejected.

### Re-importing changed files with cache-busting query strings

Re-evaluates only the entry module, so helpers keep stale code ([ADR 0015](0015-runtime-generations-and-reload.md)). Rejected.

### Replacing every handler on every change

Simpler, but every unrelated handler would get a new version and lose module state for no reason. Rejected in favour of affected modules plus their sharing closure.

### Managing module-level timers and listeners instead of refusing

The first implementation of every module is loaded by the normal loader, whose effects are not observed, so its effects could not be cleaned up; managing only later copies would still leave duplicates. Refusing and restarting is correct in every case.

## Related

- [Local development guide](../../guides/local-development.md)
- [CLI reference](../../reference/cli.md)
- [Runtime reference](../../reference/runtime.md)
- [ADR 0015: Runtime generations and reload](0015-runtime-generations-and-reload.md)
- [ADR 0025: A development supervisor with one process per generation](0025-dev-supervisor-and-process-generations.md)
