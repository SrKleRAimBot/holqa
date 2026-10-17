# 0010. TypeScript 6 until the toolchain supports TypeScript 7

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

## Context

TypeScript 7 is available. It is the native port of the compiler (Project Corsa) with much faster type checking. A new repository would normally start on the newest major version.

Holqa's lint toolchain depends on TypeScript's classic JavaScript compiler API, though, not only on the `tsc` command:

- **typescript-eslint** (8.x, used by `@antfu/eslint-config` for every `ts/*` rule and for parsing) declares support for `typescript >=4.8.4 <6.1`. Its parser (`@typescript-eslint/typescript-estree`) builds ASTs with the classic JavaScript API, and type-aware rules, which Holqa may enable later by passing a `tsconfigPath`, create full programs through it.
- **TypeScript 7 does not expose the classic JavaScript API** that typescript-eslint is built on. Its native compiler offers a different interface, and the ecosystem has not migrated to it yet.
- **tsdown is not the blocker.** Its declaration bundler (`rolldown-plugin-dts` 0.28) declares support for `typescript ~7.0.0` and `@typescript/native-preview`. Holqa relies on it to emit bundled `.d.ts` files with `@/` aliases resolved ([ADR 0011](0011-path-aliases-in-library-packages.md)), so its TypeScript 7 output must still be verified during the upgrade.

A version outside typescript-eslint's supported range risks parser crashes or incorrect lint results. Using TypeScript 7 for `tsc` and 6 for the tools would mean two compilers that may disagree about the same code.

## Decision

- The repository uses **TypeScript 6.0** (`typescript: ~6.0.3` in the pnpm catalog). The tilde range allows patch updates only, because 6.1 is outside typescript-eslint's declared range.
- One TypeScript version is used everywhere: `tsc --noEmit`, ESLint (typescript-eslint) and tsdown's declaration emit.
- Code avoids TypeScript-7-only features and nothing that is deprecated or removed in 7, so that the eventual upgrade is mechanical.

This decision is in effect.

## Consequences

### Positive

- Every tool runs inside its supported range, and lint, type-check and declaration output all agree.
- Upgrading becomes a single coordinated change when the ecosystem is ready.

### Negative

- Type checking is slower than with the native compiler. At the current repository size this is negligible.
- Contributors whose editors default to a TypeScript 7 language service may see differences. They should select the workspace TypeScript version.

### Revisit when

Revisit this ADR when **all** of the following are true:

1. typescript-eslint publishes a release whose supported range includes TypeScript 7 (or the TypeScript version Holqa targets), and `@antfu/eslint-config` adopts it.
2. tsdown's `.d.ts` output under TypeScript 7 is verified to keep `@/` aliases resolved (its declaration plugin already declares TypeScript 7 support).
3. `pnpm check`, including `examples/package-smoke`, passes on TypeScript 7 in a trial branch.

The upgrade should then supersede this ADR with a new one.

Patch and minor updates within the 6.x line that stay inside typescript-eslint's range (for example a future 6.1 once typescript-eslint supports it) do not need a new ADR. Widen the catalog range and run `pnpm check`.

## Alternatives considered

### TypeScript 7 with typescript-eslint outside its supported range

Rejected. It risks parser crashes and wrong lint results, and it ignores the peer contract.

### TypeScript 7 for `tsc`, TypeScript 6 for ESLint and tsdown

Rejected. Two compilers could disagree on errors and declaration output, and catalogs exist precisely to keep one version.

### Lint TypeScript without typescript-eslint

Rejected. typescript-eslint is integral to `@antfu/eslint-config` and to the requested conventions, such as `ts/consistent-type-imports`.

### Generate declarations with `tsc` directly instead of tsdown

Rejected. It does not address the actual blocker (typescript-eslint), and it would need a separate step to rewrite `@/` aliases.

## Related

- [`pnpm-workspace.yaml`](../../../pnpm-workspace.yaml) (catalog)
- [Code style: ESLint compatibility notes](../../contributing/code-style.md#eslint-compatibility-notes)
- [ADR 0009: Test placement and TypeScript standards](0009-test-placement-and-typescript-standards.md)
- [ADR 0011: Path aliases in library packages](0011-path-aliases-in-library-packages.md)
- typescript-eslint dependency versions: <https://typescript-eslint.io/users/dependency-versions>
