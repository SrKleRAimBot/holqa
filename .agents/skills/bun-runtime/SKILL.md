---
name: bun-runtime
description: Guidance for using Bun in the Holqa monorepo - Bun runtime APIs and their Node compatibility, the bun:test runner (expectTypeOf, mocks, watch mode), running TypeScript directly, Bun.serve and Fetch interop, module loading and hot-reload caveats, native modules, and how Bun coexists with pnpm workspaces. Use when writing or running tests, maintainer scripts, CLI code, or any code that touches Bun or bun:* APIs, when deciding whether a package may use Bun-specific APIs, or when debugging Bun resolution or runtime differences.
---

# Bun runtime

## Purpose

Bun plays two distinct roles here, and confusing them is the most common mistake:

| Role | Where | Tool |
| --- | --- | --- |
| Holqa's intended application runtime | `@holqa/cli` and `@holqa/runtime-bun` today; `@holqa/local` (planned) | Bun |
| Runtime for maintainer scripts | `scripts/*.ts` (`agents-sync.ts`, `check-boundaries.ts`) | Bun |
| Test runner | every package's `test` script (`bun test`) | Bun |
| **Repository package manager** | installs, lockfile, workspace linking | **pnpm only** |

Applications built *with* Holqa may use any package manager. That choice is unrelated to this repository's conventions.

## When to use

- Writing or running tests (`bun:test`).
- Writing or changing `scripts/*.ts` or `packages/cli`.
- Deciding whether a package may import `bun`, `bun:*`, or `node:*`.
- Debugging import resolution, `@/` aliases, or Bun vs. Node differences.
- Writing runtime code (`runtime-bun`, future `local`) that uses `Bun.serve`.

## Version and setup

- Pinned in `.bun-version` (1.3.13); root `engines.bun` is `>=1.3.13`. `.bun-version` is a Turborepo `globalDependency`, so changing it invalidates every cached task.
- Install Bun with its official installer or a version manager. Never use Bun to install repository dependencies.

## Instructions

### 1. Bun and pnpm workspaces

- `pnpm install` creates `node_modules/` with symlinked workspace packages (`node_modules/@holqa/core -> ../../packages/core`) and an isolated `.pnpm` store. Bun resolves these symlinks like Node does, so `import "@holqa/core"` works in Bun scripts and tests.
- pnpm's layout is strict: a package can only import dependencies it declares. If Bun reports `Cannot find package "x"`, add `x` to that package's `package.json` with `pnpm add` (use `catalog:` for shared versions); do not hoist or install with Bun.
- **Never** run `bun install`, `bun add`, `bun remove`, `bun update`, or `bun pm`. They would write `bun.lock` (gitignored for this reason) and an incompatible `node_modules` layout. If one was run by mistake: delete `bun.lock`/`bun.lockb` and `node_modules`, then `pnpm install`.
- Running scripts: `bun scripts/check-boundaries.ts` works, but prefer the pnpm script (`pnpm boundaries:check`) so commands stay discoverable.

### 2. Running TypeScript

- Bun transpiles TypeScript on the fly; it **does not type-check**. A file that runs under `bun` or passes `bun test` can still fail `pnpm typecheck`. Always run `tsc` (via `pnpm typecheck`) too.
- Bun reads `tsconfig.json` `paths`, so `@/` resolves to `./src/` when running tests from a package directory.
- `verbatimModuleSyntax` is on: write `import type { X }` for type-only imports or Bun/tsc output may keep a runtime import that does not exist.
- JSON imports use import attributes, as in `packages/cli/src/bin.ts`: `import packageJson from "../package.json" with { type: "json" };`.
- Useful `import.meta` fields in scripts: `import.meta.dir` (directory of the file; used by `scripts/agents-sync.ts` to find the repo root), `import.meta.path`, `import.meta.main`.

### 3. Where Bun APIs are allowed

| Location | `bun` / `bun:*` | `node:*` |
| --- | --- | --- |
| `packages/core/src`, `compiler/src`, `sdk/src`, `client/src` | forbidden (ESLint) | forbidden (ESLint) |
| `packages/cli/src`, `packages/runtime-bun/src`, future `local`, `testing` | allowed | allowed |
| `<package>/tests/**`, `examples/*/tests/**`, `scripts/**` | allowed | allowed |

Neutral packages must use Web-standard APIs (`fetch`, `Request`, `Response`, `URL`, `TextEncoder`, `structuredClone`, `crypto.subtle`). Use the global `process`/`Buffer`, never `import process from "node:process"`.

### 4. Tests with `bun:test`

```bash
pnpm test                                   # all packages, via Turborepo (builds deps first)
pnpm turbo run test --filter=@holqa/core    # one package plus its ^build dependencies
cd packages/core && bun test tests/identity # a directory or file
bun test -t "parseResourceId"               # filter by test name
pnpm --filter @holqa/core test:watch        # bun test --watch
```

- Discovery matches `*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts`. Holqa uses `*.test.ts` under `tests/` only.
- `bun test` exits **1 when no test files are found**. This is intended: a package cannot pass by having no tests.
- `expectTypeOf` from `bun:test` is a no-op at runtime; `tsc` enforces it because `tests/` is in each package's tsconfig `include`.
- Mocks: `mock(fn)`, `spyOn(object, "method")`, `mock.module(specifier, factory)`, and `mock.restore()`. Prefer dependency injection (see `CliIo` in `packages/cli/src/run.ts`) over module mocking.
- Time: `setSystemTime(new Date(...))` from `bun:test` fixes `Date.now()` for determinism; reset it with `setSystemTime()` in `afterEach`.
- Details and examples: [references/bun-test.md](references/bun-test.md).

### 5. `Bun.serve` and Fetch interop (for future runtime work)

`Bun.serve` takes a `fetch(request: Request): Response | Promise<Response>` handler, so a Holqa handler written against Web `Request`/`Response` stays portable. Keep the portable contract in neutral packages and the `Bun.serve` wiring in `runtime-bun`. On Bun 1.3.13, `server.stop(false)` resolves while idle keep-alive connections stay open and keep being served, even after a later `stop(true)`; `runtime-bun`'s `serve` therefore drains the runtime, waits for `server.pendingRequests` to reach 0 and then calls `stop(true)` once.

```ts
// Test-only sketch: start on an ephemeral port and always stop the server.
const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
try {
  const response = await fetch(new URL("/health", server.url));
  expect(await response.text()).toBe("ok");
} finally {
  server.stop(true);
}
```

Use `port: 0` in tests to avoid port collisions; always stop servers in `finally`/`afterEach`.

### 6. Module loading, lifecycle, and reload

- Modules are evaluated once and cached per process. Module-level state (registries, connections, timers) survives for the life of the process; avoid hidden global mutable state.
- `bun --watch` restarts the whole process on change. `bun --hot` re-evaluates changed modules in place and **keeps** global state, so stale servers, intervals, or registries can leak. Any future Holqa backend reload design must clean up resources explicitly; this is **Planned**, and neither flag is part of Holqa's contract.
- Top-level `await` works in ESM but delays importers; avoid it in library code.
- Bun allows `require()` of ESM; Node 22 only partially does. Published packages are ESM-only, so do not rely on `require` interop in library code.

### 7. Bun vs. Node compatibility

- Built packages target both: `engines.node >=22.13.0` for libraries; only `@holqa/cli` declares `engines.bun` and its bin uses `#!/usr/bin/env bun`.
- Bun implements most `node:*` modules, but gaps exist. When using a `node:*` API in Bun-run code, check the Bun Node-compatibility page for the pinned version.
- Bun-only APIs (`Bun.file`, `Bun.spawnSync`, `Bun.Transpiler`, `Bun.serve`) must not appear in code that Node consumers load.

### 8. Dependencies and native modules

- Prefer pure-JS, ESM dependencies. Bun supports Node-API addons, but not every V8-specific native module works.
- pnpm does not run dependency build scripts unless they are approved (`pnpm approve-builds`). An addon that needs a build step is a red flag: justify it, test it under Bun, and discuss it before adding.

## Verification checklist

- [ ] No `bun.lock`, `bun.lockb`, or `package-lock.json` exists (`git status` is clean of them).
- [ ] No `bun`, `bun:*`, or `node:*` imports in `core`, `compiler`, `sdk`, or `client` `src/` (`pnpm lint` passes).
- [ ] `pnpm typecheck` passes (Bun alone does not type-check).
- [ ] Tests are deterministic: servers use `port: 0` and are stopped; time and randomness are injected or fixed.
- [ ] `pnpm test` (or a filtered `pnpm turbo run test`) passes, and you report its real output.
- [ ] Any change to `.bun-version` is stated in the summary.

## References

- Bun documentation: https://bun.com/docs
  - Test runner: https://bun.com/docs/test, https://bun.com/docs/test/mocks, https://bun.com/docs/test/dates-times
  - TypeScript: https://bun.com/docs/runtime/typescript, module resolution: https://bun.com/docs/runtime/module-resolution
  - HTTP server: https://bun.com/docs/runtime/http/server; watch and hot modes: https://bun.com/docs/runtime/watch-mode
  - Node.js compatibility: https://bun.com/docs/runtime/nodejs-compat; Node-API: https://bun.com/docs/runtime/node-api
  - Offline copy: the `bun-types` package (installed through `@types/bun`) ships these pages as Markdown under its `docs/` directory.
- pnpm workspaces: https://pnpm.io/workspaces
- Local: [ADR 0002 Bun as primary runtime](../../../docs/architecture/decisions/0002-bun-as-primary-runtime.md), [docs/contributing/development.md](../../../docs/contributing/development.md), [docs/contributing/testing.md](../../../docs/contributing/testing.md), [references/bun-test.md](references/bun-test.md)
- Related skills: `testing`, `pnpm-turborepo`, `holqa-architecture`
