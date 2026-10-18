# Development guide

How to set up, build, test and extend the Holqa monorepo. For code conventions see [code style](code-style.md). For tests see [testing](testing.md).

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 22.13 | `engines` in `package.json`. CI uses the version in `.node-version` (24). Runs ESLint, `tsc`, tsdown and Turborepo. |
| pnpm | 12.14.0 | Pinned through `packageManager`. The **only** package manager for this repository. |
| Bun | 1.3.13 | Pinned in `.bun-version`. Runs tests, the `holqa` CLI and `scripts/*.ts`. Never used to install dependencies. |

Getting pnpm 12.14.0 (any one of these works):

- **pnpm ≥ 11 installed globally.** It reads `packageManager` and switches to 12.14.0 automatically.
- **Corepack:** `corepack enable`, after which `pnpm` resolves to the pinned version.
- **No global pnpm:** prefix commands with `npx pnpm@12.14.0`, for example `npx pnpm@12.14.0 install`.

pnpm 10 cannot do the automatic switch, because pnpm 12 is a native binary. See [troubleshooting](#troubleshooting).

## Setup

```bash
git clone https://github.com/SrKleRAimBot/holqa.git
cd holqa
pnpm install
pnpm check
```

`pnpm check` builds every package and runs every quality gate. If it passes, your environment is working.

Do not run `bun install`, `npm install` or `yarn`. They create competing lockfiles (which are git-ignored for that reason) and a different `node_modules` layout.

## Root scripts

| Command | What it does |
| --- | --- |
| `pnpm build` | `turbo run build`: runs tsdown in each package and emits ESM `.js` plus bundled `.d.ts` into `dist/`. Dependencies build first (`^build`). Cached. |
| `pnpm dev` | `turbo run dev`: `tsdown --watch` in every package. Persistent and uncached. |
| `pnpm typecheck` | `turbo run typecheck typecheck:repo`: `tsc --noEmit` per package (sources **and** tests, so type-level tests are checked), plus `tsc` over root `scripts/`. Builds dependencies first. |
| `pnpm lint` | `turbo run lint lint:repo`: `eslint .` per package, plus a root ESLint pass over everything outside `packages/`, `experiments/`, `examples/package-smoke/` and `examples/commerce/` (scripts, config, JSON and YAML, agent files). |
| `pnpm lint:fix` | `eslint . --fix` over the whole repository in one process (not through Turborepo). |
| `pnpm test` | `turbo run test`: `bun test` per package, including `examples/package-smoke`, `examples/commerce` and the M0 experiments. Builds dependencies first. |
| `pnpm test:watch` | `bun test --watch` per package. Persistent. Use it with `--filter` (see below). |
| `pnpm clean` | Deletes `dist/` and `.turbo/` in each package, then the root `node_modules/.cache` and `.turbo`. |
| `pnpm check` | Every gate in one Turborepo run: `build typecheck typecheck:repo lint lint:repo test agents:check boundaries:check`. CI runs this. Run it before opening a pull request. |
| `pnpm agents:sync` | Copies `.agents/rules` and `.agents/skills` into `.claude/` and deletes stale mirror files. See [agent instructions](agent-instructions.md). |
| `pnpm agents:check` | Fails if `.claude/` has drifted from `.agents/` or if `CLAUDE.md` does not import `@AGENTS.md`. |
| `pnpm boundaries:check` | Runs `scripts/check-boundaries.ts`: allowed dependency directions (including the `experiments/*` mirror table), `workspace:` protocol, no package or module cycles, every `@holqa/*` import declared, no tests in `src/`. |
| `pnpm changeset` | Records a change for release notes and versioning. See [releasing](releasing.md). |

## Running tasks for one package

Turborepo and pnpm both accept filters:

```bash
# Run a package script directly (no dependency builds)
pnpm --filter @holqa/core test

# Through Turborepo, so dependencies are built first
pnpm turbo run test --filter=@holqa/compiler

# A package and all of its dependencies
pnpm turbo run build --filter=@holqa/cli...

# A package and everything that depends on it
pnpm turbo run test --filter=...@holqa/core

# Watch tests in one package
pnpm --filter @holqa/core test:watch
```

`pnpm --filter <pkg> <script>` does not build dependencies. If the package imports another `@holqa/*` package, that package's `dist/` must exist and be current. Use the `turbo run` form when in doubt.

## Repository layout

```text
holqa/
├── packages/
│   ├── core/            @holqa/core: contracts, diagnostics, descriptors, validation, wire payloads (implemented, private)
│   ├── compiler/        @holqa/compiler: canonical JSON, schema contracts (implemented, private)
│   ├── cli/             @holqa/cli: `holqa` bin, help/version only (implemented, private)
│   ├── sdk/             @holqa/sdk: application and resource model (implemented, private)
│   ├── testing/         @holqa/testing: type assertions (implemented, private)
│   ├── runtime-bun/ local/ client/     planned: README only
│   └── integrations/
│       ├── zod/         @holqa/zod: Zod 4 schema adapter (implemented, private)
│       └── {valibot,effect,orpc,tanstack-query}/   planned: README only
├── examples/
│   ├── package-smoke/   consumes built packages, checks dist output (runs in pnpm test)
│   ├── schema-evolution/  end-to-end schema contract corpus with Zod (runs in pnpm test)
│   ├── commerce/        reference application, tested against the M0 experiments
│   ├── basic-backend/   illustrative application structure (does not run)
│   └── fullstack-vite/  illustrative application structure (does not run)
├── experiments/         disposable M0 prototypes (model, sdk, compiler, runtime-bun, schema-adapters)
├── docs/                architecture, concepts, ADRs, reference, milestones, contributor guides
├── skills/              public Agent Skills for Holqa users (not mirrored)
├── .agents/             canonical contributor rules and skills
├── .claude/             generated mirror of .agents/ + Claude-only files
├── scripts/             agents-sync.ts, check-boundaries.ts (run with Bun)
├── tooling/             tsconfig.package.json (shared package tsconfig)
├── tsconfig.base.json   strict compiler options shared by everything
├── tsconfig.json        type-checks root scripts/
├── eslint.config.mjs    the single ESLint flat config
├── turbo.json           task graph
└── pnpm-workspace.yaml  workspace globs, catalog, pnpm settings
```

Each implemented package has the same shape:

```text
packages/<name>/
├── package.json
├── tsconfig.json        extends ../../tooling/tsconfig.package.json, maps @/* → ./src/*
├── tsdown.config.ts
├── src/index.ts         the public entry point: export only what is public
└── tests/               mirrors src/
```

## Adding a new package

The planned packages (`sdk`, `runtime-bun`, `local`, `testing`, `client`, integrations) already have a directory and a README. Start from that directory. Do not create a package until it has a real API to implement. Every package starts as `"private": true`.

### 1. `package.json`

```json
{
  "name": "@holqa/sdk",
  "type": "module",
  "version": "0.0.0",
  "private": true,
  "description": "One sentence describing what is actually implemented.",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/SrKleRAimBot/holqa.git",
    "directory": "packages/sdk"
  },
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "types": "./dist/index.d.ts",
  "files": [
    "dist"
  ],
  "engines": {
    "node": ">=22.13.0"
  },
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "test": "bun test",
    "test:watch": "bun test --watch",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@holqa/core": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:"
  }
}
```

- Internal dependencies use `workspace:*`. Third-party versions go in the `catalog:` block of `pnpm-workspace.yaml` and are referenced as `"catalog:"`.
- Bun-only packages (such as `@holqa/cli`) declare `"engines": { "bun": ">=1.3.13" }` instead of `node`.

### 2. `tsconfig.json`

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../../tooling/tsconfig.package.json",
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src", "tests", "tsdown.config.ts"]
}
```

For packages under `packages/integrations/`, the relative paths get one more `../`. Keep `tests` in `include`, otherwise type-level tests are never checked.

### 3. `tsdown.config.ts`

```typescript
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "neutral",
  dts: true,
  sourcemap: false,
  clean: true
});
```

Use `platform: "neutral"` for framework-neutral packages (`core`, `compiler`, `sdk`, `client`) and `platform: "node"` for packages that use runtime APIs (as `cli` does). Every additional entry must also appear in `exports`. Source files end without a trailing newline (`style/eol-last: never`).

### 4. Source and tests

- `src/index.ts` re-exports the public API. Inside the package, import through `@/`.
- Add at least one test in `tests/`, mirroring `src/`. `bun test` fails when it finds no tests.

### 5. Register the dependency direction

Add the package to `allowedDependencies` in [`scripts/check-boundaries.ts`](../../scripts/check-boundaries.ts) (integration packages use `integrationDependencies` automatically). An unlisted framework package fails `pnpm boundaries:check`. The current table:

| Package | May depend on |
| --- | --- |
| `@holqa/core` | nothing |
| `@holqa/sdk`, `@holqa/client`, `@holqa/compiler`, `@holqa/runtime-bun` | `@holqa/core` |
| `@holqa/local` | `core`, `runtime-bun` |
| `@holqa/testing` | `core`, `sdk`, `local`, `runtime-bun` |
| `@holqa/cli` | `core`, `compiler`, `local`, `runtime-bun` |
| `packages/integrations/*` | `core`, `sdk`, `client` |

Changing a direction is an architectural change. Update [package boundaries](../architecture/package-boundaries.md) in the same pull request.

### 6. Add ESLint import restrictions

In [`eslint.config.mjs`](../../eslint.config.mjs):

- If the package is framework-neutral, add its `src/**` glob to `neutralPackageSources`. That forbids `bun`, `bun:*`, `node:*` and the runtime, tooling and testing packages.
- If it needs restrictions beyond that (as `core`, `sdk` and `client` have), add a `files: ["packages/<name>/src/**"]` block with `no-restricted-imports`. Include `noDeepPackageImports` in its `patterns`, because a later block replaces the rule's options rather than merging them.

### 7. Wire it into verification and docs

- If the package emits build output, add it to `examples/package-smoke`: a `workspace:*` dependency and an entry in the `packages` list in `tests/published-artifacts.test.ts`, plus a public-export test.
- Update the package's README, [packages reference](../reference/packages.md) and, if it introduces diagnostic codes, [diagnostic codes](../reference/diagnostic-codes.md).
- Run `pnpm install`, then `pnpm check`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `ERROR Failed to switch pnpm to v12.14.0 ... spawnSync .../pnpm ENOEXEC` | Your global pnpm is 10.x, which cannot launch pnpm 12's native binary. Upgrade to pnpm ≥ 11, use Corepack, or run `npx pnpm@12.14.0 <command>`. |
| pnpm refuses to install a version because it was published too recently | pnpm 12 enforces a minimum release age for newly published versions. Pick an older version, or wait for the window to pass. Do not add an exclusion (`minimumReleaseAgeExclude`) unless a maintainer agrees and the reason is commented in `pnpm-workspace.yaml`. |
| A test or typecheck in package B cannot find a new export from package A | B resolves A through A's built `dist/`, and `dist/` is stale. Run `pnpm build` (or use `pnpm turbo run ...`, which builds dependencies first). |
| A task replays an old cached result after changes Turborepo cannot see (for example a global tool upgrade) | Rerun with `--force`, for example `pnpm turbo run test --force`, or run `pnpm clean`. If a task really depends on a file it does not declare, add that file to its `inputs` in `turbo.json`. |
| `bun test` reports that no tests were found | The package has no `*.test.ts` files under `tests/`. Add tests, because empty suites intentionally fail. |
| `pnpm agents:check` fails | Someone edited `.claude/rules` or `.claude/skills` directly, or edited `.agents/` without syncing. Make the change in `.agents/`, run `pnpm agents:sync`, and commit both. |
| `pnpm boundaries:check` reports "not listed in allowedDependencies" | A new framework package was added without a dependency direction. See [step 5](#5-register-the-dependency-direction). |
| ESLint reports `path-alias/no-relative` | Replace `../foo` with `@/foo` inside a package's `src/` or `tests/`. |
| A `bun.lock` or `package-lock.json` appeared | Someone ran another package manager. Delete the file and `node_modules`, then run `pnpm install`. |
