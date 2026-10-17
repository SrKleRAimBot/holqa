---
name: typescript-library
description: Conventions for designing and shipping Holqa's TypeScript library packages - ESM exports maps, declaration generation with tsdown, @/ path aliases and why they never leak into dist, public API stability, inference and negative type tests, dependency boundaries, exactOptionalPropertyTypes patterns, branded types, and Result-versus-throw error design. Use when adding or changing exported APIs, types, or generics in packages/*, editing tsconfig or tsdown configs, designing error handling, or checking that built output and declarations are correct.
---

# TypeScript library design

## Purpose

Holqa's packages are libraries consumed through their `exports` maps, so source conventions, build output, and type-level contracts all matter. This skill covers how to design public APIs that stay stable and how to verify what actually ships.

## When to use

- Adding or changing anything exported from `packages/*/src/index.ts`.
- Designing generic types or inference-heavy APIs.
- Editing `tsconfig*.json`, `tsdown.config.ts`, or a package's `exports`.
- Choosing between returning `Result` and throwing.

## Compiler settings (do not loosen)

`tsconfig.base.json` uses TypeScript 6.0 with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`, `noUnusedLocals`/`Parameters`, `verbatimModuleSyntax`, `isolatedModules`, `module: "Preserve"`, `moduleResolution: "bundler"`, `target`/`lib` ES2023. Packages extend `tooling/tsconfig.package.json` (adds Bun types for tests) and include `src`, `tests`, and `tsdown.config.ts`.

## Instructions

### 1. Package shape

```json
{
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "types": "./dist/index.d.ts",
  "files": ["dist"]
}
```

- ESM only. `types` comes first inside each export condition.
- One public entry point, `src/index.ts`. Add a subpath export only with a documented reason; every subpath is public API.
- `src/index.ts` contains only re-exports; values and types use separate statements:

```ts
export {
  isResourceId,
  maxResourceIdLength,
  parseResourceId
} from "@/identity/resource-id";
export type { ResourceId } from "@/identity/resource-id";
```

(ESLint requires multiline export lists with three or more specifiers and multiline import lists with two or more.)

### 2. Build and declarations (tsdown)

```ts
// packages/core/tsdown.config.ts
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "neutral",  // "node" plus fixedExtension: false only for packages that need Node/Bun APIs (cli)
  dts: true,
  sourcemap: false,
  clean: true
});
```

tsdown (Rolldown) emits `dist/index.js` and a bundled `dist/index.d.ts`. `tsc` is used only for `typecheck` (`noEmit`).

### 3. `@/` aliases

- Each package tsconfig maps `@/*` → `./src/*`. ESLint's `path-alias/no-relative` requires `@/` instead of relative imports inside `src/` and `tests/`.
- tsdown resolves `@/` while bundling both JS and declarations, so no `@/` specifier reaches `dist/`. `examples/package-smoke/tests/published-artifacts.test.ts` fails if any built `.js` or `.d.ts` contains `from "@/` or `import("@/`.
- `@/` is package-local. To use another package, import it by name (`@holqa/core`), declared with `workspace:*`.
- Files outside `src/` that the alias cannot reach (for example `src/bin.ts` importing `../package.json` with `with { type: "json" }`) are the only acceptable relative imports.

### 4. Public API stability

- Export the minimum. Helpers stay unexported (see `formatLocation` in `diagnostics/diagnostic.ts`).
- Prefer `readonly` properties and return frozen objects from constructors (`ok`, `err`, `createDiagnostic`).
- Prefer interfaces and discriminated unions for data; avoid classes except for errors.
- Removing or narrowing an export, adding a required parameter, or widening a return type is breaking. Explain the impact (see the `safe-refactoring` skill).

### 5. Patterns for strict options

**`exactOptionalPropertyTypes`**: optional means "may be absent", not "may be `undefined`". Omit fields instead of assigning `undefined`:

```ts
const diagnostic: Diagnostic = {
  code: input.code,
  severity: input.severity,
  message: input.message,
  ...(input.hint === undefined ? {} : { hint: input.hint })
};
```

**`noUncheckedIndexedAccess`**: `array[i]` and `record[key]` are `T | undefined`. Narrow before use; do not add `!`.

**`noPropertyAccessFromIndexSignature`**: use `record["key"]` for index signatures, dot access for declared properties.

### 6. Branded types

```ts
declare const resourceIdBrand: unique symbol;
export type ResourceId = string & { readonly [resourceIdBrand]: true };
```

Only the parsing function casts (`value as ResourceId`) after validation. Callers cannot pass unvalidated strings, and tests assert that with `@ts-expect-error`.

### 7. `Result` vs. throw

| Situation | Use |
| --- | --- |
| Expected, recoverable failure on untrusted input | `Result<T, Diagnostic>` (`parseResourceId`) |
| Value cannot be represented and callers need a located error | Throw a named `Error` subclass carrying `.diagnostic` (`CanonicalJsonError`) and document it with `@throws` |
| Programmer error or broken invariant | Throw |

Never swallow errors. Diagnostics use codes from `diagnosticCodes` only.

### 8. Inference testing

Test public types in `tests/` with `expectTypeOf` and negative cases with `@ts-expect-error`:

```ts
const result = parseResourceId("orders");
if (result.ok)
  expectTypeOf(result.value).toEqualTypeOf<ResourceId>();
// @ts-expect-error `value` is not accessible before narrowing.
expect(result.value).toBe("orders");
```

`pnpm typecheck` enforces these; `bun test` alone does not. Also assert inference through the built package in `examples/package-smoke` when the change affects emitted declarations.

### 9. Dependency boundaries

`core` imports nothing internal; `compiler`, `sdk`, `client` import only `core`; neutral packages never import `bun`, `bun:*`, or `node:*`. See the `holqa-architecture` skill for the full table.

## Verification checklist

- [ ] New exports are re-exported from `src/index.ts` with separate `export type` lines, and each has a JSDoc summary.
- [ ] No `any`, `!` non-null assertions to silence `noUncheckedIndexedAccess`, or suppressed TS errors.
- [ ] Optional fields are omitted, not set to `undefined`.
- [ ] Positive and negative type tests exist for new generics or branded types.
- [ ] `pnpm turbo run build typecheck test --filter=...<package>` passes.
- [ ] `pnpm turbo run test --filter=@holqa/example-package-smoke` passes (no `@/` leaks, exports resolve).
- [ ] Compatibility impact of any public change is stated; docs/reference updated.

## References

- TypeScript: https://www.typescriptlang.org/tsconfig, https://www.typescriptlang.org/docs/handbook/modules/reference.html
- Node.js package entry points: https://nodejs.org/api/packages.html#package-entry-points
- tsdown: https://tsdown.dev
- Local: [ADR 0009](../../../docs/architecture/decisions/0009-test-placement-and-typescript-standards.md), [ADR 0010](../../../docs/architecture/decisions/0010-typescript-6-until-tooling-supports-7.md), [ADR 0011](../../../docs/architecture/decisions/0011-path-aliases-in-library-packages.md), [docs/reference/packages.md](../../../docs/reference/packages.md), [docs/contributing/code-style.md](../../../docs/contributing/code-style.md)
- Related skills: `code-quality`, `testing`, `safe-refactoring`
