# Holqa agent instructions

Holqa is an open-source, TypeScript-native, infrastructure-agnostic framework for declaring an application's
resource graph (HTTP/RPC APIs, queues, storage, schedules, configuration) and the event-driven handlers that use it.
This repository is the single source of truth for the framework, its tooling, documentation and agent skills.

**Status: bootstrap.** Only small foundations are implemented (see [docs/reference/packages.md](docs/reference/packages.md)).
Most of the architecture is accepted design or planned work.

## Read first

- Architecture and concepts: [docs/index.md](docs/index.md). Read the relevant docs and ADRs
  ([docs/architecture/decisions/](docs/architecture/decisions/README.md)) before any architectural change.
- Status vocabulary (Implemented / Accepted design / Proposed / Planned): [docs/architecture/status-model.md](docs/architecture/status-model.md).
- Focused rules: [.agents/rules/](.agents/rules/). Procedures: [.agents/skills/](.agents/skills/). Use the skill that matches your task.

## Stack

pnpm 12 (the only package manager; never use npm/yarn/bun to install), Turborepo, TypeScript 6 (strict), Bun 1.3
(runtime and test runner), ESLint 10 with `@antfu/eslint-config`, tsdown for builds, Changesets for versioning.

## Non-negotiable rules

- **Never claim unimplemented capabilities exist.** Label proposed APIs and commands as such in code, docs and replies.
- **Keep core packages infrastructure-neutral.** No provider SDKs, provider config bags or runtime-specific imports in
  `@holqa/core`, `@holqa/compiler`, `@holqa/sdk` or `@holqa/client`. Respect the dependency directions in
  [docs/architecture/package-boundaries.md](docs/architecture/package-boundaries.md).
- **Document every named function, method and class** with a meaningful summary (C# XML-doc style), plus `@param`,
  `@returns` and `@throws` where relevant. Describe behavior, not the name.
- **Tests live in `<package>/tests/`, mirroring `src/`.** Use `bun:test`; add negative type tests for public generics.
- **Style:** double quotes, semicolons, no trailing commas, no final newline in code files, `import type` for types,
  `@/` aliases instead of relative imports inside a package. Run `pnpm lint:fix`; never disable rules to pass.
- **Safety:** never expose secrets, never perform or automate destructive infrastructure actions silently, never
  fabricate command output or test results. Explain compatibility impact when changing public APIs.
- Make small, verifiable changes within the task's scope. Add tests for new behavior and update docs when contracts change.

## Before you finish

Run `pnpm check` (build, typecheck, lint, tests, agent mirror and boundary checks), or the narrower
`pnpm --filter <package> <task>` while iterating, and report the actual results. After editing `.agents/`, run
`pnpm agents:sync`.
