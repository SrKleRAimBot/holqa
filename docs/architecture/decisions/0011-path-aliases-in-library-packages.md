# 0011. `@/` path aliases in library packages

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

## Context

The maintainers prefer alias-based imports to deep relative paths:

```typescript
import { createDiagnostic } from "@/diagnostics/diagnostic";
// instead of
import { createDiagnostic } from "../../diagnostics/diagnostic";
```

In applications this is easy, because the bundler resolves the alias and nothing is published. Holqa packages are published libraries, so an alias has to work in six places:

| Place | Concern |
| --- | --- |
| Editor | Go-to-definition and auto-imports |
| `tsc` type-check | Resolution under `moduleResolution: "bundler"` |
| Tests | `bun test` runs sources directly |
| Bundler | Emitted `dist/*.js` |
| Declarations | Emitted `dist/*.d.ts` |
| Published package | Consumers must never see `@/...` specifiers, which would not resolve for them |

A TypeScript `paths` mapping alone covers only the first two. TypeScript does not rewrite module specifiers in its output.

## Decision

1. **Each package maps `@/*` to its own `./src/*`** in its `tsconfig.json`:

   ```json
   { "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
   ```

   The alias is local to the package. `@/` in `packages/core` means `packages/core/src`.
2. **tsdown resolves the alias at build time.** tsdown (Rolldown) reads the package's tsconfig `paths` and bundles the targets, and its declaration bundler does the same for `.d.ts`. `dist/` therefore contains no `@/` specifiers.
3. **Bun resolves the alias in tests** by reading `tsconfig.json` `paths`, so tests import `@/...` with no extra configuration.
4. **ESLint enforces the alias.** `path-alias/no-relative` (from `eslint-plugin-path-alias`, which reads each package's tsconfig `paths`) reports relative imports inside a package's `src/` and `tests/`. Files without `paths` in their tsconfig (root `scripts/`, examples) are unaffected. Files outside `src/` that `@/` cannot reach, such as the CLI's `../package.json` import, keep relative paths.
5. **Cross-package imports use package names** (`@holqa/core`) through `exports`, never `@/`, relative paths into another package, or deep paths into `src/` or `dist/`. ESLint `no-restricted-imports` and `scripts/check-boundaries.ts` enforce this.
6. **Verification.** `examples/package-smoke` scans every built `dist/*.js` and `dist/*.d.ts` of `@holqa/core`, `@holqa/compiler` and `@holqa/cli` for `from "@/` and `import("@/` and fails if any are found. It also consumes the packages through their public exports and runs the built `holqa` bin. It runs in `pnpm test` and `pnpm check`.

This decision is in effect.

## Consequences

### Positive

- Imports are stable when files move within a package, and are readable.
- Published output is self-contained. The smoke test catches regressions, for example a new entry point or a tsdown change that leaks aliases.
- No extra build step or alias-rewriting tool.

### Negative

- Correctness depends on every consumer of the sources understanding tsconfig `paths`: tsdown, Bun, `tsc`, editors and ESLint. A tool that does not (for example running a package's sources under plain Node.js) cannot resolve `@/`.
- The same `@/` prefix means a different directory in each package. That is unambiguous per file, but it can confuse someone reading across packages.
- If tsdown is ever replaced, the replacement must resolve `paths` in both JavaScript and declaration output, or the smoke test will fail.

## Alternatives considered

### Node.js subpath imports (`#/*` via `package.json` `"imports"`)

A credible alternative. Node, Bun, TypeScript (`moduleResolution: "bundler"` or `"nodenext"`) and most bundlers resolve subpath imports natively from `package.json`, so no rewriting is needed and unbundled output would still resolve. It was not chosen because:

- The maintainers' existing convention, and the ESLint rule they use (`path-alias/no-relative`), are built around tsconfig `paths` and `@/`.
- The `imports` target must point to a location that exists in the *published* package. Mapping to `src/` breaks consumers unless `src/` is published or conditions are used to switch between `src/` and `dist/`, which adds complexity to every manifest.
- Since tsdown bundles everything anyway, native resolution brings little practical benefit today.

Revisit if Holqa stops bundling (for example to ship unbundled ESM), or if TypeScript-native `#/` support makes the `src`/`dist` mapping simpler.

### Relative imports only

Rejected as the convention. It always works without tooling, but deep `../../..` chains are hard to read and break when files move. It remains the fallback for files that `@/` cannot reach.

### `tsc` plus `tsc-alias` (or similar rewriting)

Rejected. It needs a post-processing step that rewrites specifiers in `.js` and `.d.ts` after `tsc` emits, adds a tool, and duplicates what tsdown already does in one pass.

### A shared repository-wide alias (`@holqa-internal/*`)

Rejected. It would invite cross-package imports that bypass `exports`, which is the boundary violation this repository is set up to prevent.

## Related

- [`examples/package-smoke`](../../../examples/package-smoke/), specifically [`tests/published-artifacts.test.ts`](../../../examples/package-smoke/tests/published-artifacts.test.ts)
- [Code style: ESLint compatibility notes](../../contributing/code-style.md#eslint-compatibility-notes)
- [Development guide: adding a package](../../contributing/development.md#adding-a-new-package)
- [Package boundaries](../package-boundaries.md)
- [ADR 0010: TypeScript 6](0010-typescript-6-until-tooling-supports-7.md)
- Node.js subpath imports: <https://nodejs.org/api/packages.html#subpath-imports>. tsdown: <https://tsdown.dev>
