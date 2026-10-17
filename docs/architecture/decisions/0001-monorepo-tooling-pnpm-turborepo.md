# 0001. Monorepo tooling: pnpm, Turborepo and Changesets

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

## Context

Holqa is going to be a family of packages: a framework-neutral core, a public SDK, a compiler, a Bun runtime adapter, a CLI, local emulation, testing utilities, a client runtime, and several integration packages. These packages change together, depend on each other in a fixed direction, and need consistent TypeScript, lint and test settings. One repository has to hold the libraries, documentation, examples, agent instructions and ADRs.

That calls for:

- A package manager with reliable workspace support, a deterministic lockfile, strict dependency isolation (no phantom dependencies), and one place to declare shared dependency versions.
- A task runner that understands the package graph, builds dependencies before dependents, and caches results only where caching is valid.
- A versioning workflow that records changes per package and supports independent SemVer versions, even though nothing is published yet.

Bun can also install dependencies (see [ADR 0002](0002-bun-as-primary-runtime.md)). Having two package managers in one repository would mean competing lockfiles and resolution behaviour that differs between machines.

## Decision

**pnpm is the only package manager for this repository.**

- The version is pinned through `"packageManager": "pnpm@12.14.0"` in the root `package.json`.
- `pnpm-lock.yaml` is committed. `package-lock.json`, `yarn.lock`, `bun.lock` and `bun.lockb` are listed in `.gitignore` and must never be committed.
- Workspace packages are listed in `pnpm-workspace.yaml`: `packages/*`, `packages/integrations/*` and `examples/*`.
- Internal dependencies use `workspace:*`. `scripts/check-boundaries.ts` rejects any other specifier for `@holqa/*` dependencies.
- Shared third-party versions live in the `catalog:` block of `pnpm-workspace.yaml`. Package manifests reference them with `"catalog:"`. The antfu ESLint config's pnpm rules enforce this.
- Supply-chain settings in `pnpm-workspace.yaml`: `trustPolicy: no-downgrade`, `minimumReleaseAgeExcludePrune: true` and `shellEmulator: true`. pnpm 12 refuses to install package versions newer than its minimum release age. Exclusions from that guard are not added casually: waiting for the age window is the default answer.
- Peer-dependency exceptions are narrow and commented. The only one today is `peerDependencyRules.allowedVersions` for `eslint-plugin-path-alias>eslint` (see [code style](../../contributing/code-style.md#eslint-compatibility-notes)).

**Turborepo (2.11.x) orchestrates tasks** through `turbo.json`:

| Task | Depends on | Cached | Notes |
| --- | --- | --- | --- |
| `build` | `^build` | Yes, outputs `dist/**` | Inputs exclude `tests/**` and `README.md`, so editing a test does not invalidate builds. |
| `typecheck` | `^build` | Yes, no outputs | Cross-package imports resolve to dependencies' built `dist/`. |
| `test` | `^build` | Yes, no outputs | Same reason as `typecheck`. |
| `lint` | none | Yes | `eslint.config.mjs` is an explicit input (`$TURBO_ROOT$/eslint.config.mjs`). |
| `lint:fix`, `clean` | none | No | These tasks mutate files, so caching them is invalid. |
| `dev`, `test:watch` | `^build` | No | Persistent, long-running processes. |
| `//#typecheck:repo`, `//#lint:repo`, `//#agents:check`, `//#boundaries:check` | none | Yes | Root-level tasks covering `scripts/`, docs, agent files and the boundary rules. |

`tsconfig.base.json`, `tooling/tsconfig.package.json` and `.bun-version` are `globalDependencies`, so changing them invalidates every cached task. `pnpm check` runs every quality gate in one Turborepo invocation: `build typecheck typecheck:repo lint lint:repo test agents:check boundaries:check`.

**Changesets** (`@changesets/cli`) records version intent. Every package is `"private": true` today, so Changesets has nothing to publish, and no automated publishing is configured. See [releasing](../../contributing/releasing.md).

This decision is in effect: the repository is configured this way today.

## Consequences

### Positive

- One lockfile and one resolver. CI and every contributor get the same dependency graph.
- pnpm's isolated `node_modules` layout surfaces undeclared dependencies early. `scripts/check-boundaries.ts` additionally checks that every `@holqa/*` import is declared.
- Catalogs keep TypeScript, ESLint, tsdown and the other tools on one version across all packages.
- Turborepo skips unchanged work locally, and `pnpm check` is the single command that CI and contributors run.
- Changesets lets future releases version packages independently, with per-package changelogs.

### Negative

- pnpm 12 is a native binary. pnpm 10's `packageManager` auto-switch cannot launch it and fails with `Failed to switch pnpm to v12.14.0 ... ENOEXEC`. Contributors need pnpm 11 or newer, Corepack, or `npx pnpm@12.14.0` (see [development](../../contributing/development.md#troubleshooting)).
- The minimum release age means a freshly published fix cannot be installed right away.
- Because `typecheck` and `test` depend on `^build`, a cold run builds every dependency first. This is the cost of consuming packages through their real `exports`.
- Contributors who are used to Bun must not run `bun install` here.

## Alternatives considered

### Bun as the package manager (`bun install`, `bun.lock`)

Rejected. Bun is Holqa's runtime and test runner, but pnpm's workspace protocol, catalogs, strict isolation, peer-dependency rules and supply-chain settings are more mature for a library monorepo. Two package managers would mean two lockfiles. Applications built *with* Holqa may still use any package manager.

### npm or Yarn workspaces

Rejected. npm workspaces have no catalogs, and npm's hoisting allows phantom dependencies. Yarn Berry is capable, but Plug'n'Play adds compatibility friction with Bun and some tooling, and switching it off removes most of Yarn's advantage over pnpm.

### Nx (or no orchestrator, only `pnpm -r`)

Nx was rejected as more framework than this repository needs: generators, plugins and project configuration on top of `package.json` scripts. Plain `pnpm -r run` handles ordering but has no caching or input hashing. Turborepo adds a cached task graph on top of ordinary package scripts and nothing more.

### Manual versioning or semantic-release

Rejected. Manual versioning does not scale across interdependent packages. semantic-release infers versions from commit messages repository-wide, which fits a monorepo with independent package versions poorly. Changesets records the intent per pull request.

## Related

- [`package.json`](../../../package.json), [`pnpm-workspace.yaml`](../../../pnpm-workspace.yaml), [`turbo.json`](../../../turbo.json)
- [Development guide](../../contributing/development.md)
- [Releasing](../../contributing/releasing.md)
- [Package boundaries](../package-boundaries.md)
- [ADR 0002: Bun as the primary runtime](0002-bun-as-primary-runtime.md)
- pnpm catalogs: <https://pnpm.io/catalogs>. Turborepo task configuration: <https://turborepo.com/docs/reference/configuration>. Changesets: <https://github.com/changesets/changesets>
