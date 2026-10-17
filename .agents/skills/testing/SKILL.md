---
name: testing
description: How to write and run tests in the Holqa monorepo - test placement under tests/ mirroring src/, bun:test usage, compile-time type tests with expectTypeOf and @ts-expect-error, determinism rules, fixtures, the examples/package-smoke consumer test, the no-empty-suite rule, and honest reporting of results. Use when adding a feature or fixing a bug, adding or changing public types, writing fixtures, debugging a failing or flaky test, or deciding which validation commands to run before finishing.
---

# Testing

## Purpose

Tests prove behavior, type contracts, determinism, and packaging. Holqa uses Bun's native test runner for runtime assertions and `tsc` for type-level assertions. This skill describes where tests go, what they must cover, and how to run them.

## When to use

- Any change to behavior or public types (new tests are required).
- Bug fixes (add a regression test that fails before the fix).
- Changes to build output, exports, or the CLI bin (extend the smoke example).
- Investigating a failing or flaky test.

## Placement

```text
packages/core/
├── src/identity/resource-id.ts
└── tests/identity/resource-id.test.ts
```

- Mirror `src/` under `tests/` with a `.test.ts` suffix. One test file per source module is the default.
- Never put tests in `src/`. ESLint (`no-restricted-syntax` for `**/src/**/*.{test,spec}.ts`) and `pnpm boundaries:check` both reject it, and `build` inputs exclude `tests/**`.
- Import code under test with `@/` (`import { parseResourceId } from "@/identity/resource-id";`). Do not import from `../src`.
- Test-only helpers live under `tests/` (for example `tests/fixtures/`), never in `src/`.

## Running tests

```bash
pnpm test                                        # all packages via Turborepo (builds dependencies first)
pnpm turbo run test --filter=...@holqa/core      # core plus every dependent (compiler, cli, smoke example)
pnpm turbo run test --filter=@holqa/compiler     # one package; turbo still runs ^build for its deps
cd packages/core && bun test tests/result.test.ts   # one file, fastest loop (deps must already be built)
bun test -t "rejects"                            # filter by test name
pnpm --filter @holqa/core test:watch             # watch mode
pnpm typecheck                                   # REQUIRED: enforces expectTypeOf and @ts-expect-error
```

`bun test` does not type-check. A green `bun test` with a failing `pnpm typecheck` is a failing change.

## Instructions

### Runtime tests

```ts
import {
  describe,
  expect,
  it
} from "bun:test";

import { canonicalJsonStringify } from "@/manifest/canonical-json";

describe("canonicalJsonStringify", () => {
  it("is independent of key insertion order", () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe(canonicalJsonStringify({ a: 2, b: 1 }));
  });
});
```

- Use `it.each` for tables of valid/invalid inputs (see `tests/identity/resource-id.test.ts`).
- For failures, assert the stable contract: `result.error.code`, `error.diagnostic.code`, the JSON path, exit codes. Use `toContain` for messages rather than full-string equality unless the format is the contract (as with `formatDiagnostic`).
- Narrow `Result` before asserting: `if (!result.ok) expect(result.error.code).toBe("HOLQA_RESOURCE_ID_INVALID");`.

### Type tests

```ts
it("brands successful values so plain strings are not assignable", () => {
  const result = parseResourceId("orders");
  if (result.ok)
    expectTypeOf(result.value).toEqualTypeOf<ResourceId>();

  // @ts-expect-error A plain string is not a validated ResourceId.
  const unvalidated: ResourceId = "orders";
  expect(isResourceId(unvalidated)).toBe(true);
});
```

- Add positive (`toEqualTypeOf`, `toExtend`) and negative (`@ts-expect-error` with a reason) cases for every public generic, branded type, or discriminated union.
- `@ts-expect-error` is allowed only in tests and must explain the expected error.

### Determinism

- No real network, no reliance on wall-clock time, randomness, environment variables, locale, timezone, or test order.
- Inject dependencies instead of mocking modules: `runCli(argv, io, version)` takes `CliIo` so tests capture output without touching `process.stdout`.
- Fix time with `setSystemTime()` from `bun:test` and reset it in `afterEach`.
- Servers bind `port: 0` and are stopped in `finally`/`afterEach`.
- Temporary files go in a fresh directory under the OS temp dir and are removed afterwards.
- Run `bun test --rerun-each 5` on a suspicious file to expose flakiness.

### Fixtures

- Keep fixtures small and inline when possible. Larger fixtures go in `tests/fixtures/` with descriptive names.
- Golden output for serialized artifacts must be produced by `canonicalJsonStringify`, so fixtures are byte-stable.
- Never put real credentials or personal data in fixtures.

### Smoke example

`examples/package-smoke` (`@holqa/example-package-smoke`) imports the **built** packages by name and:

- checks values and types through public exports (`tests/package-exports.test.ts`);
- checks that every `dist/*.js` and `dist/*.d.ts` exists and contains no unresolved `@/` import (`tests/published-artifacts.test.ts`);
- runs the built `holqa` bin with Bun and asserts exit codes and `--json` diagnostics.

When you add a package or public entry point, add it to the smoke example's dependencies and the `packages` list.

### No empty suites

`bun test` exits 1 when it finds no test files. A package with a `test` script must have real tests. Do not add placeholder tests to make it pass, and do not remove the `test` script to avoid the failure.

## Reporting

- Run the commands; report the real outcome (pass/fail counts or the failing output).
- Never claim tests pass without running them. If you could not run them, say so and why.
- Never skip, delete, or loosen a failing test without explaining it in the summary.

## Verification checklist

- [ ] New behavior has runtime tests under `tests/` mirroring `src/`.
- [ ] New or changed public types have `expectTypeOf` and `@ts-expect-error` cases.
- [ ] Failure paths assert diagnostic codes, not just "throws".
- [ ] Tests are deterministic and isolated; no `.only` left behind.
- [ ] `pnpm typecheck` and the relevant `pnpm turbo run test --filter=...` pass.
- [ ] Smoke example updated if exports, packages, or the bin changed.
- [ ] `pnpm check` passes before declaring the task done, with real output reported.

## References

- Bun test runner: https://bun.com/docs/test, https://bun.com/docs/test/mocks, https://bun.com/docs/test/dates-times
- Local: [docs/contributing/testing.md](../../../docs/contributing/testing.md), [ADR 0009](../../../docs/architecture/decisions/0009-test-placement-and-typescript-standards.md), [examples/package-smoke](../../../examples/package-smoke/), `bun-runtime` skill reference [bun-test.md](../bun-runtime/references/bun-test.md)
- Related skills: `bun-runtime`, `typescript-library`, `code-quality`
