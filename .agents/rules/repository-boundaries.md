# Repository boundaries

- Treat this repository as the single source of truth for Holqa. Read the relevant files under `docs/` (start with [docs/architecture/overview.md](../../docs/architecture/overview.md) and [package-boundaries.md](../../docs/architecture/package-boundaries.md)) and the related ADRs before any architectural change.
- Respect the allowed internal dependency directions. Dependencies point inward toward `@holqa/core`:

| Package | May depend on |
| --- | --- |
| `@holqa/core` | nothing |
| `@holqa/sdk`, `@holqa/client`, `@holqa/compiler`, `@holqa/runtime-bun` | `@holqa/core` |
| `@holqa/local` | core, runtime-bun |
| `@holqa/testing` | core, sdk, local, runtime-bun |
| `@holqa/cli` | core, compiler, local, runtime-bun |
| `packages/integrations/*` | core, sdk, client |
| `examples/*` | anything |

- Do not import `bun`, `bun:*`, or `node:*` from `core`, `compiler`, `sdk`, or `client` source. Runtime-specific code belongs in `runtime-bun`, `local`, or `cli`.
- Never import `@holqa/compiler`, `runtime-*`, `local`, `cli`, or `testing` from `sdk` or `client`.
- Never deep-import another package (`@holqa/core/src/...`, `../core/dist/...`). Use the package's `exports`.
- Declare every `@holqa/*` import in the importing package's `package.json` with `workspace:*`.
- Keep `src/` free of circular module imports and test files.
- A new framework package must be added to `allowedDependencies` in [`scripts/check-boundaries.ts`](../../scripts/check-boundaries.ts) and documented in `docs/architecture/package-boundaries.md`; the check fails otherwise.
- Keep separate: `packages/` (Holqa libraries), `skills/` (public skills for Holqa users), `.agents/` (contributor instructions), `docs/` (authoritative docs), `examples/`, `experiments/` (disposable M0 prototypes; never a dependency of `packages/`), `scripts/` (maintainer automation).
- Stay within the task. Do not make speculative edits, refactors, or "while I'm here" changes outside the requested scope; propose them separately.
- Prefer small, verifiable changes over large rewrites.
- Run `pnpm boundaries:check` after changing imports, dependencies, or package layout.

See the `holqa-architecture` and `safe-refactoring` skills.
