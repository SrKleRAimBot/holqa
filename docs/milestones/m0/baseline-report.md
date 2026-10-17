# M0 repository baseline report

> **Status:** Results recorded on 2026-10-17 against commit `8f47587` (bootstrap), before any M0 changes.

This report records whether the bootstrap scaffold passes its intended checks. Every result below comes from a command that was actually run. Environment: macOS (arm64), Bun 1.3.13, Node.js 22.20.0, pnpm 12.14.0 (run through `npx -y pnpm@12.14.0` because the machine's global pnpm 10 cannot switch to pnpm 12), TypeScript 6.0.3.

## Summary

| Area | Result |
| --- | --- |
| Install | Pass. `pnpm install --frozen-lockfile` resolved 468 packages; supply-chain policy check passed. |
| Full gate (`pnpm check`) | Pass. 19 of 19 tasks, with the cache bypassed (`--force`). |
| Build | Pass. `@holqa/core`, `@holqa/compiler` and `@holqa/cli` build with tsdown 0.23.1. |
| Typecheck | Pass for all packages and the repository scripts. |
| Lint | Pass, for packages and the repository root. |
| Tests | Pass. core 27, compiler 16, cli 9, package-smoke 6 (58 tests, 0 failures). |
| Agent mirror (`agents:check`) | Pass. |
| Boundaries (`boundaries:check`) | Pass. |
| Package exports | Pass. publint (all three packages, `--strict`) and Are the Types Wrong (ESM resolution). See [package exports](#package-exports). |
| Release tooling | Configured. No pending changesets; private packages are not versioned or tagged. |
| CI | Pass. The last CI runs on the bootstrap pull request and on `main` succeeded in about 40 s. |
| Documentation links | Pass. One reported hit is a placeholder (`NNNN-title.md`) in prose. |

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Done in 0.7 s. 468 packages, no install scripts run. |
| `pnpm check` | 19 successful, 18 cached. The cache entries were replayed from the main checkout, so the gate was re-run with `--force`. |
| `pnpm turbo run build typecheck typecheck:repo lint lint:repo test agents:check boundaries:check --force` | 19 successful, 0 cached, 2.7 s. |
| `npx publint --pack npm --strict` (in each package) | "All good!" for `@holqa/core`, `@holqa/compiler` and `@holqa/cli`. |
| `npx @arethetypeswrong/cli --pack . --profile esm-only` (in each package) | Green for `node16 (from ESM)` and `bundler`; CommonJS consumers need a dynamic import, which is intended for ESM-only packages. |
| `pnpm changeset status` | No packages to bump. `privatePackages.version` and `.tag` are `false`. |
| `gh run list` | CI `success` on the bootstrap pull request (39 s) and on the `main` push (40 s); Dependabot update `success`. |
| A relative-link checker over 111 Markdown files | 1 hit: the `NNNN-title.md` placeholder in the ADR README (not a real link target). |

## Package exports

All three packages expose a single `.` entry (`types` before `import`) plus `./package.json`, set `"sideEffects": false`, ship only `dist/`, and contain no unresolved `@/` aliases in emitted files (checked by `examples/package-smoke`).

Caveats:

- publint's default `pnpm pack` fails on this machine because the global pnpm is version 10. This is an environment problem, not a repository problem; `--pack npm` was used instead.
- `npm pack` does not rewrite `workspace:*` specifiers. Publishing must use `pnpm publish`, which does. Nothing is published today, and every package is private.
- Export validation (publint, Are the Types Wrong) is not part of `pnpm check` or CI. See the [backlog](backlog.md).

## Findings

| Finding | Impact | Follow-up |
| --- | --- | --- |
| Turborepo replays cache entries between worktrees ("using shared worktree cache"), including logs that mention the other checkout's paths. | A green `pnpm check` can be a cache replay. Correct, but it can mislead when validating a fresh checkout. | Document `--force` for baseline runs; see the backlog. |
| ESLint's `dot-notation` autofix rewrites `record["key"]` to `record.key`, which then fails TypeScript's `noPropertyAccessFromIndexSignature`. Reproduced in `packages/core`. | `pnpm lint:fix` can produce code that does not type-check. | Backlog: replace the rule with a configuration that respects index signatures. The lint configuration was not changed in M0. |
| Bun 1.3.13's runtime `expectTypeOf` does not implement `.parameter()`. | Type tests that call it compile but throw at runtime. | Use `Parameters<...>` in type tests (see the [type inference experiment](../../../experiments/sdk/README.md#findings)); documenting it in the testing skill is backlog item HB-03. |
| TypeScript 6 refuses file arguments when a `tsconfig.json` is present (TS5112) unless `--ignoreConfig` is passed. | Ad-hoc `tsc file.ts` checks silently fail to run. | Documented here and in the type-inference experiment. |
| CI and `pnpm check` do not validate exports with publint or Are the Types Wrong. | Export regressions would only be caught by `package-smoke`. | Backlog. |

## Changes made in M0

M0 changed repository tooling so that the experiments could be checked like the rest of the code:

- `pnpm-workspace.yaml`: added `experiments/*` as a workspace location, and added `zod`, `valibot` and `@valibot/to-json-schema` to the catalog.
- `scripts/check-boundaries.ts`: experiments are discovered and checked against an `experimentDependencies` table that mirrors the target layering. Their development dependencies are exempt, and their `src/` code may import only production dependencies.
- `eslint.config.mjs`: the runtime-neutral import restrictions now also apply to `experiments/{model,sdk,schema-adapters,compiler}/src`; the SDK/client restrictions also apply to `experiments/sdk/src`.
- `package.json` (`lint:repo`): ignores `experiments/**` and `examples/commerce/**`, which lint themselves as workspace packages.
- `.gitignore`: ignores `experiments/*/.tmp/`.

The gate was re-run after these changes; see the [M0 summary](index.md#validation).

## Related

- [M0 summary](index.md)
- [Development setup](../../contributing/development.md)
- [Package boundaries](../../architecture/package-boundaries.md)
