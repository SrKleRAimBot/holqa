---
paths:
  - "packages/**/*.ts"
---

# TypeScript and public API

- Keep every package compiling under `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`). Never loosen these options in a package `tsconfig.json`.
- Do not use `any`. Accept untrusted input as `unknown` and narrow explicitly. If `any` is genuinely unavoidable, isolate it and explain why in a comment.
- Never add `@ts-ignore`, `@ts-nocheck`, or a non-test `@ts-expect-error` to make checks pass. Fix the type instead.
- Model protocols and states as discriminated unions (for example `Result<T, E>` with `ok: true | false`), not bags of optional properties.
- With `exactOptionalPropertyTypes`, omit absent optional fields instead of assigning `undefined`: `...(hint === undefined ? {} : { hint })`.
- Return `Result<T, Diagnostic>` from `@holqa/core` for expected, recoverable failures (invalid input). Throw only for programmer errors, invariants, or where a documented error class carries a `diagnostic` (for example `CanonicalJsonError`).
- Use branded types for validated values (see `ResourceId`) and construct them only through a parsing function.
- Use named exports. Use default exports only when an external framework contract requires one.
- Export the public API only from `src/index.ts`. Use separate `export type { ... }` lines for types.
- Import within a package through `@/` (maps to `./src`). Import other packages only through their package name (`@holqa/core`), never `src/` or `dist/` paths.
- Every function, method, class, named arrow/function expression, and exported interface, type, or const needs a JSDoc summary that says what it does, plus `@param`/`@returns` descriptions. Public APIs also document `@throws` and add `@example` where usage is not obvious. Do not use JSDoc type annotations.
- Prefer small, cohesive modules; composition over inheritance; no hidden global mutable state; no circular imports.
- Return immutable data (`readonly` fields, `Object.freeze`) from public constructors such as `ok`, `err`, and `createDiagnostic`.
- Changing an exported name, signature, type, or behavior is a public API change: state the compatibility impact in your summary and follow [backward-compatibility.md](backward-compatibility.md).
- Add type tests (`expectTypeOf`, `@ts-expect-error`) when you add or change public generic types.

See the `typescript-library` skill and [docs/contributing/code-style.md](../../docs/contributing/code-style.md).
