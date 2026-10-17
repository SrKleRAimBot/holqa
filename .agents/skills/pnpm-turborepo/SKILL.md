---
name: pnpm-turborepo
description: How the Holqa monorepo is wired with pnpm workspaces and Turborepo - adding or changing dependencies (workspace:* and catalog:), adding packages, the task graph (^build ordering, inputs/outputs, cache-safe tasks, root //# tasks), filtered commands, and troubleshooting install, cache, and pnpm version-switch errors. Use when editing package.json, pnpm-workspace.yaml, or turbo.json, adding a dependency or package, running a subset of tasks, or when an install, build ordering, or cache result looks wrong.
---

# pnpm and Turborepo

## Purpose

pnpm installs and links every workspace package; Turborepo orchestrates `build`, `typecheck`, `lint`, `test`, and the root checks with dependency-aware ordering and caching. This skill gives the exact conventions and commands used in this repository.

## When to use

- Adding, removing, or upgrading a dependency.
- Creating a new workspace package.
- Editing `turbo.json` tasks, inputs, outputs, or root tasks.
- Running tasks for a subset of packages.
- Diagnosing install failures, stale builds, or suspicious cache hits.

## Versions and files

| Item | Value |
| --- | --- |
| pnpm | `packageManager: "pnpm@12.14.0"` in root `package.json`; the only package manager |
| Turborepo | `turbo` 2.11.x via `catalog:` |
| Workspaces | `pnpm-workspace.yaml`: `packages/*`, `packages/integrations/*`, `examples/*` |
| Lockfile | `pnpm-lock.yaml` (committed). No `bun.lock`, `package-lock.json`, or `yarn.lock` |
| Shared versions | `catalog:` block in `pnpm-workspace.yaml` |
| Supply-chain settings | `trustPolicy: no-downgrade`, minimum release age enforced by pnpm 12, `minimumReleaseAgeExcludePrune: true` |

## Instructions

### Dependencies

- **Internal**: always `"@holqa/core": "workspace:*"`. `scripts/check-boundaries.ts` rejects any other specifier and any direction not allowed by its `allowedDependencies` table.
- **Shared third-party** (used by 2+ packages or the root): add the version once to `catalog:` in `pnpm-workspace.yaml`, reference it as `"catalog:"`.

```yaml
# pnpm-workspace.yaml
catalog:
  tsdown: ^0.23.1
  typescript: ~6.0.3
```

```json
{ "devDependencies": { "tsdown": "catalog:", "typescript": "catalog:" } }
```

- Commands:

```bash
pnpm --filter @holqa/compiler add @holqa/core@workspace:*   # internal dependency
pnpm --filter @holqa/cli add -D some-tool                    # then move the version into catalog: if shared
pnpm add -D -w some-root-tool                                # root devDependency
pnpm install                                                 # after any manual manifest edit
pnpm why <package>                                           # why is it installed
```

- Keep runtime `dependencies` minimal; tools are `devDependencies`.
- `typescript` is pinned to `~6.0.3`. Do not upgrade to 7: typescript-eslint 8 supports `<6.1` and TS 7's native compiler has no classic JS API (see [ADR 0010](../../../docs/architecture/decisions/0010-typescript-6-until-tooling-supports-7.md)).

### Task graph (`turbo.json`)

| Task | Cached | Depends on | Notes |
| --- | --- | --- | --- |
| `build` | yes, `outputs: ["dist/**"]` | `^build` | inputs exclude `tests/**` and `README.md` |
| `typecheck` | yes | `^build` | cross-package types come from built `dist/*.d.ts` |
| `lint` | yes | none | inputs include `$TURBO_ROOT$/eslint.config.mjs` |
| `lint:fix` | no | none | writes files |
| `test` | yes | `^build` | tests import dependencies through their `dist/` |
| `test:watch`, `dev` | no, `persistent` | `^build` | long-running |
| `clean` | no | none | |
| `//#typecheck:repo` | yes | none | `tsc -p tsconfig.json` for `scripts/` |
| `//#lint:repo` | yes | none | ESLint for files outside `packages/` and `examples/package-smoke` |
| `//#agents:check` | yes | none | `.agents/` vs `.claude/` drift |
| `//#boundaries:check` | yes | none | dependency directions and module cycles |

`globalDependencies` (`tsconfig.base.json`, `tooling/tsconfig.package.json`, `.bun-version`) invalidate every task when changed.

**Why `^build`**: each package's `exports` point at `./dist/`, so `@holqa/compiler` importing `@holqa/core` resolves to core's built output. Typecheck and tests therefore need dependencies built first.

### Cache safety

- Cache a task only if its result is a pure function of its declared inputs.
- Declare everything a task writes in `outputs`; undeclared outputs are not restored on a cache hit.
- If a task reads an environment variable, list it in the task's `env` (or `globalEnv`), otherwise a cached result can be replayed under different settings.
- Root `//#` tasks need explicit `inputs`, because the default for the root would include the whole repository. When you add a directory that a root task reads, add it to that task's `inputs`.
- Watch/dev tasks: `"cache": false, "persistent": true`. Persistent tasks cannot be dependencies of other tasks.
- Never add `--force` or `cache: false` to hide a real invalidation bug; fix the inputs.

### Filtered commands

```bash
pnpm turbo run build --filter=@holqa/cli...      # cli and its dependencies
pnpm turbo run test --filter=...@holqa/core      # core and everything depending on it
pnpm turbo run test --filter=@holqa/compiler     # compiler tests; turbo still builds its deps (^build)
pnpm --filter @holqa/core test                   # pnpm runs the script directly: NO dependency builds
pnpm turbo run build --dry=json                  # inspect the task graph without running
pnpm turbo run test --force                      # bypass the cache once (debugging only)
```

Prefer `pnpm turbo run <task> --filter=...` over `pnpm --filter <pkg> <script>` whenever the package depends on other workspace packages, because only Turborepo applies `^build`.

### Root scripts

`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:fix` (runs `eslint . --fix` directly), `pnpm test`, `pnpm test:watch`, `pnpm dev`, `pnpm clean`, `pnpm agents:sync`, `pnpm agents:check`, `pnpm boundaries:check`, `pnpm changeset`, and `pnpm check` (one Turborepo run of `build typecheck typecheck:repo lint lint:repo test agents:check boundaries:check`).

### Adding a workspace package

1. Copy the structure of `packages/core`: `package.json`, `tsconfig.json` (`@/*` → `./src/*`), `tsdown.config.ts`, `src/index.ts`, `tests/`.
2. Set `"private": true`, `"version": "0.0.0"`, standard scripts, `exports`, `files: ["dist"]`, `sideEffects: false`.
3. Add the package and its allowed dependencies to `allowedDependencies` in `scripts/check-boundaries.ts`, and add ESLint import restrictions in `eslint.config.mjs` if it is runtime-neutral.
4. Write at least one real test (empty suites fail `bun test`).
5. Add it to `examples/package-smoke` (dependency and the `packages` list in `tests/published-artifacts.test.ts`).
6. Document it in `docs/architecture/package-boundaries.md` and `docs/reference/packages.md`.
7. `pnpm install && pnpm check`.

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md) for full fixes. Quick table:

| Symptom | Likely cause |
| --- | --- |
| `Failed to switch pnpm to v12.14.0 ... ENOEXEC` | Running pnpm 10; it cannot launch pnpm 12's native binary |
| Install rejects a newly published version | pnpm minimum release age |
| Install fails with a trust/provenance downgrade | `trustPolicy: no-downgrade` |
| `Cannot find module '@holqa/core'` or stale types in a dependent | Dependency not built; you used `pnpm --filter` instead of turbo |
| Cache hit after a change that should matter | Missing `inputs`/`env` |

## Verification checklist

- [ ] Only `pnpm-lock.yaml` changed among lockfiles; no `bun.lock`/`package-lock.json`.
- [ ] Internal dependencies use `workspace:*`; shared versions use `catalog:`.
- [ ] `pnpm install` completes without editing supply-chain settings.
- [ ] New/changed tasks have correct `dependsOn`, `outputs`, `inputs`, and `env`; watch tasks are uncached and persistent.
- [ ] `pnpm boundaries:check` passes.
- [ ] `pnpm check` passes, and you report its actual output.

## References

- pnpm: https://pnpm.io/workspaces, https://pnpm.io/catalogs, https://pnpm.io/filtering, https://pnpm.io/settings
- Turborepo: https://turborepo.com/docs/reference/configuration, https://turborepo.com/docs/crafting-your-repository/caching, https://turborepo.com/docs/reference/run#--filter-string
- Local: [ADR 0001](../../../docs/architecture/decisions/0001-monorepo-tooling-pnpm-turborepo.md), [docs/contributing/development.md](../../../docs/contributing/development.md), [docs/architecture/package-boundaries.md](../../../docs/architecture/package-boundaries.md), [references/troubleshooting.md](references/troubleshooting.md)
- Related skills: `bun-runtime`, `typescript-library`, `release-management`
