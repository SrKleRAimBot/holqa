# 0009. Test placement and TypeScript standards

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

## Context

Holqa's packages will be published libraries whose value depends on precise types: inferred message types, branded identifiers, discriminated diagnostics. This places requirements on both tests and compiler settings:

- Shipped `src/` directories should contain only shipped code. Colocated tests leak into builds, inflate packages, and blur what is public.
- Type behaviour is part of the public contract and needs tests, including negative tests showing that invalid usage fails to compile.
- A test run that finds no tests should not pass silently.
- TypeScript's default `strict` mode still allows unchecked index access, optional properties that accept explicit `undefined`, and implicit overrides. Each of these hides bugs that matter in protocol and manifest code.
- Public APIs need documentation that explains intent, not only signatures.

## Decision

### Test placement

- Tests live in `<package>/tests/`, mirroring `src/`: `src/a/b.ts` is tested by `tests/a/b.test.ts`.
- Test files under `src/` are rejected twice: by an ESLint `no-restricted-syntax` rule for `**/src/**/*.{test,spec}.{ts,tsx}`, and by `scripts/check-boundaries.ts`.
- Tests use Bun's runner (`bun:test`) and import package internals through the `@/` alias ([ADR 0011](0011-path-aliases-in-library-packages.md)). `bun test` exits non-zero when it finds no test files, so an empty suite cannot pass.
- Type-level tests use `expectTypeOf` from `bun:test` and `// @ts-expect-error` for negative cases. `bun test` does not type-check, so these assertions are enforced by `pnpm typecheck`: each package's `tsconfig.json` includes `tests/`.
- Cross-package behaviour is verified through public exports by `examples/package-smoke`, which consumes the built packages.

### TypeScript standards

All packages extend `tooling/tsconfig.package.json`, which extends `tsconfig.base.json`:

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals`, `noUnusedParameters`.
- ESM settings: `module: "Preserve"`, `moduleResolution: "bundler"`, `verbatimModuleSyntax`, `isolatedModules`, `moduleDetection: "force"`. tsdown emits the JavaScript and declarations, and `tsc` only type-checks (`noEmit`).
- Code conventions: no `any` without a written justification, `unknown` with narrowing at boundaries, discriminated unions for protocol and state types, and no suppressing errors to pass checks.
- **Documentation comments are required** on named functions, methods, classes and named function expressions, and on exported types, interfaces and constants. The style is C# XML-doc summaries written as TSDoc, with `@param`, `@returns` and `@throws`, and `@example` where useful. `eslint-plugin-jsdoc` enforces this, with the fixer disabled so that no empty stubs are generated. See [code style](../../contributing/code-style.md#documentation-comments).

This decision is in effect and enforced by `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm boundaries:check`.

## Consequences

### Positive

- Shipped `dist/` output cannot include tests, and `src/` reads as the public implementation.
- Type contracts are tested in the same CI gate as runtime behaviour.
- The stricter compiler flags catch index, optionality and override mistakes before review.
- Documentation required on every function produces usable API reference text and helps agents understand intent.

### Negative

- Mirrored test paths take some upkeep when files move.
- `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` make some code more verbose (conditional spreads, bracket access).
- Mandatory documentation costs writing time, and a lint rule cannot judge quality. Reviewers still have to reject comments that restate the name. `jsdoc/informative-docs` catches only the most obvious cases.
- Type tests depend on `pnpm typecheck` being run. `bun test` alone does not check them.

## Alternatives considered

### Colocated `*.test.ts` files in `src/`

Rejected. They have to be excluded from builds and package `files`, and the maintainers prefer a clean `src/`.

### Separate type-testing tools (`tsd`, `vitest --typecheck`, `expect-type`)

Rejected for now. `expectTypeOf` from `bun:test` plus `@ts-expect-error`, checked by `tsc`, covers the current needs without another tool.

### Default `strict` only

Rejected. The extra flags catch real classes of bugs in protocol and serialization code at low cost.

### Documentation only on exported symbols

Rejected. The maintainers want C#-style summaries on every named function, because internal helpers are where intent is hardest to recover. Short inline callbacks are exempt.

## Related

- [Testing guide](../../contributing/testing.md)
- [Code style](../../contributing/code-style.md)
- [`tsconfig.base.json`](../../../tsconfig.base.json), [`tooling/tsconfig.package.json`](../../../tooling/tsconfig.package.json), [`eslint.config.mjs`](../../../eslint.config.mjs)
- [ADR 0010: TypeScript 6](0010-typescript-6-until-tooling-supports-7.md)
- [ADR 0011: Path aliases](0011-path-aliases-in-library-packages.md)
