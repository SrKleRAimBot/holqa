---
paths:
  - "**/package.json"
  - "pnpm-workspace.yaml"
  - "turbo.json"
  - "**/tsdown.config.ts"
---

# Packages and dependencies

- Use pnpm (version pinned by `packageManager`, currently `pnpm@12.14.0`) for every install. Commit `pnpm-lock.yaml`. Never create other lockfiles or run `bun install`/`npm install`.
- Reference internal packages with `workspace:*`. Reference shared third-party versions with `catalog:` and define the version once in the `catalog:` block of `pnpm-workspace.yaml`.
- Keep runtime `dependencies` minimal. Build/test tools (`tsdown`, `typescript`, `@types/bun`) are `devDependencies`.
- Every new package is `"private": true`, `"type": "module"`, `"sideEffects": false`, `"files": ["dist"]`, `license: "Apache-2.0"`, with `exports` `{ ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }, "./package.json": "./package.json" }`.
- Every package provides the standard scripts: `build` (`tsdown`), `dev` (`tsdown --watch`), `typecheck` (`tsc --noEmit`), `lint`, `lint:fix`, `test` (`bun test`), `test:watch`, `clean`.
- Build with tsdown (ESM only, `dts: true`). Use `platform: "neutral"` for runtime-neutral packages and `platform: "node"` with `fixedExtension: false` only where Node/Bun APIs are required (as in `@holqa/cli`).
- Add new framework packages to `allowedDependencies` in `scripts/check-boundaries.ts` and to `examples/package-smoke` (dependency plus the `packages` list in its artifact test).
- In `turbo.json`, cache only deterministic tasks; mark watch/dev tasks `"cache": false, "persistent": true`. Declare `outputs` for anything a task writes and `inputs`/`env` for anything that affects its result.
- Do not change `minimumReleaseAge`/`trustPolicy` settings or add `peerDependencyRules` exceptions without a comment explaining the verification, as in the existing `eslint-plugin-path-alias` entry.
- Do not approve dependency build scripts casually; justify each approval.
- Do not set `"private": false`, add `publishConfig`, or publish anything without explicit maintainer instruction.
- After changing manifests run `pnpm install`, then `pnpm boundaries:check` and `pnpm check`.

See the `pnpm-turborepo` and `release-management` skills.
