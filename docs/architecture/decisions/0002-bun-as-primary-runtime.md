# 0002. Bun as the primary runtime and test runner

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

## Context

Holqa's intended execution model (an [accepted design](../../concepts/triggers-and-execution.md), not implemented yet) runs application handlers, local emulators and developer tooling on one JavaScript runtime. The runtime affects:

- Startup time and TypeScript execution without a separate compile step, which matter for local development and tests.
- Built-in primitives: an HTTP server on the Fetch API (`Bun.serve`), file I/O and process spawning.
- The test runner used across the monorepo.

Bun runs TypeScript directly, ships a fast built-in test runner (`bun test`) with Jest-compatible APIs and `expectTypeOf`, and implements most Node.js APIs. It also ships a package manager, which this repository deliberately does not use (see [ADR 0001](0001-monorepo-tooling-pnpm-turborepo.md)).

Holqa libraries are also published packages. Consumers may run tooling or parts of the stack under Node.js, so framework-neutral packages must not depend on Bun.

## Decision

1. **Bun is Holqa's primary intended runtime.** The future `@holqa/runtime-bun` package (planned, not implemented) will hold Bun-specific execution adapters.
2. **Bun runs the repository's TypeScript programs.** The `holqa` CLI bin (`#!/usr/bin/env bun`, `"engines": { "bun": ">=1.3.13" }`) and maintainer scripts (`scripts/agents-sync.ts`, `scripts/check-boundaries.ts`) run on Bun.
3. **Bun is the test runner.** Every package's `test` script is `bun test`, and tests import from `bun:test`. See [ADR 0009](0009-test-placement-and-typescript-standards.md).
4. **Bun is not the package manager.** `bun install` is never run in this repository and no Bun lockfile is committed. pnpm installs everything, and Bun runs against pnpm's `node_modules` layout.
5. **The Bun version is pinned** in `.bun-version` (1.3.13). The file is a Turborepo `globalDependency`, so a version bump invalidates cached results.
6. **Framework-neutral packages stay runtime-neutral.** `@holqa/core`, `@holqa/compiler`, and the planned `@holqa/sdk` and `@holqa/client` must not import `bun`, `bun:*` or `node:*`. ESLint `no-restricted-imports` enforces this. `core` and `compiler` build with tsdown `platform: "neutral"`.

Points 2 to 6 are in effect today. Point 1 is a design direction: no Bun runtime adapter exists yet.

### Node.js compatibility considerations

- Library packages declare `"engines": { "node": ">=22.13.0" }`, and their built output is plain ESM that runs on Node.js and on Bun. CI uses the Node version in `.node-version` (24) for Node-based tools such as ESLint, tsc and tsdown.
- Tests run only under Bun. Because framework-neutral sources cannot import runtime modules, passing Bun tests are a reasonable proxy for Node behaviour in those packages, but not a guarantee. Add Node-specific verification if a package starts depending on behaviour that differs between runtimes.
- Bun-specific APIs (`Bun.spawnSync`, `import.meta.dir`, `bun:test`) are allowed in tests, scripts, the CLI and the future runtime adapter. They are not allowed in neutral packages.
- Bun reads `tsconfig.json` `paths`, so `@/` aliases resolve in tests without a build step (see [ADR 0011](0011-path-aliases-in-library-packages.md)).

## Consequences

### Positive

- Tests and scripts run TypeScript directly, with no transpile step or test-framework configuration.
- One runtime for the CLI, scripts and tests keeps contributor setup small.
- The rule that neutral packages stay runtime-neutral keeps future Node.js or other runtime adapters possible.

### Negative

- Contributors must install Bun as well as Node.js and pnpm.
- Bun's Node.js compatibility is broad but incomplete. Dependencies that use native addons or rare Node internals need checking under Bun before adoption.
- Test results reflect Bun's behaviour. Node-only differences can slip through unless they are tested explicitly.
- Bun's package-manager features are easy to invoke by habit (`bun add`, `bun install`). Contributors and agent instructions must avoid them.

## Alternatives considered

### Node.js as the primary runtime, with Vitest or `node:test`

Rejected as the *primary* choice. Node.js is a supported target for built library output, but making it primary would add a TypeScript execution layer (a loader, or type stripping with its restrictions) and a separate test framework. Holqa's intended local-development experience is built around Bun's speed and built-in server.

### Bun as runtime *and* package manager

Rejected. See [ADR 0001](0001-monorepo-tooling-pnpm-turborepo.md): pnpm's workspace features, catalogs and supply-chain controls are the deciding factors, and two lockfiles are not acceptable.

### Deno

Rejected. Deno is capable, but its npm and workspace compatibility model differs more from the Node ecosystem that Holqa's integrations (Vite, TanStack, Drizzle and others) target.

### Vitest as the test runner while keeping Bun as runtime

Rejected for now. Vitest would bring a Vite-based transform pipeline and another configuration surface without a compatibility problem that requires it. This can be revisited if `bun test` blocks a needed capability.

## Related

- [`.bun-version`](../../../.bun-version), [`.node-version`](../../../.node-version)
- [Testing guide](../../contributing/testing.md)
- [Development guide](../../contributing/development.md)
- [Package boundaries](../package-boundaries.md)
- [Triggers and execution](../../concepts/triggers-and-execution.md)
- Bun Node.js compatibility: <https://bun.sh/docs/runtime/nodejs-apis>
