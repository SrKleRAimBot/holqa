# Testing

Holqa uses Bun's built-in test runner. This guide covers where tests go, how type-level tests work, and what to test. The reasons behind these conventions are in [ADR 0009](../architecture/decisions/0009-test-placement-and-typescript-standards.md).

## Running tests

```bash
pnpm test                                  # every package, dependencies built first
pnpm turbo run test --filter=@holqa/core   # one package, dependencies built first
pnpm --filter @holqa/core test             # one package, no dependency build
pnpm --filter @holqa/core test:watch       # watch mode
cd packages/core && bun test tests/identity  # a subset, from the package directory
pnpm typecheck                             # required for type-level tests (see below)
```

Tests import other `@holqa/*` packages through their built `dist/`. If a cross-package import looks stale, run `pnpm build`.

## Placement

Tests live in the package's top-level `tests/` directory, mirroring `src/`:

```text
packages/core/
├── src/
│   └── identity/
│       └── resource-id.ts
└── tests/
    └── identity/
        └── resource-id.test.ts
```

- Name test files `*.test.ts`.
- Never put tests under `src/`. ESLint (`no-restricted-syntax`) and `pnpm boundaries:check` both reject them.
- Import the code under test through the package alias (`@/identity/resource-id`), not with relative paths.
- Shared fixtures for one package go in `tests/fixtures/` or a helper module under `tests/`, never in `src/`.

## Writing tests

```typescript
import {
  describe,
  expect,
  it
} from "bun:test";

import { parseResourceId } from "@/identity/resource-id";

describe("parseResourceId", () => {
  it.each(["orders", "order-processing", "orders.process"])("accepts %p", (candidate) => {
    expect(parseResourceId(candidate).ok).toBe(true);
  });

  it("rejects uppercase identifiers with HOLQA_RESOURCE_ID_INVALID", () => {
    const result = parseResourceId("Orders");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.code).toBe("HOLQA_RESOURCE_ID_INVALID");
  });
});
```

- Use `describe` per unit and an `it` name that states the behaviour ("rejects ... with CODE"), not the method name.
- Use `it.each` for tables of valid and invalid inputs.
- Assert on stable contract surfaces: return values, diagnostic `code` and `severity`, exit codes, serialized output. Avoid asserting full human-readable messages unless the message is the contract. `toContain` on a key fragment is usually enough.
- Tests follow the same lint rules as source. Named helper functions need documentation comments, and anonymous `describe`/`it` callbacks are exempt.

## Type-level tests

Types are part of the public contract. Test them in the same files:

```typescript
import type { ResourceId } from "@/identity/resource-id";

import {
  expect,
  expectTypeOf,
  it
} from "bun:test";

import { parseResourceId } from "@/identity/resource-id";

it("brands successful values so plain strings are not assignable", () => {
  const result = parseResourceId("orders");
  if (result.ok)
    expectTypeOf(result.value).toEqualTypeOf<ResourceId>();

  // @ts-expect-error A plain string is not a validated ResourceId.
  const invalid: ResourceId = "orders";
  expect(invalid).toBe("orders");
});
```

- `expectTypeOf(...)` from `bun:test` asserts on inferred types. It does nothing at run time.
- `// @ts-expect-error <reason>` marks a negative test: the next line **must** fail to compile. If it compiles, `tsc` reports an unused directive. A description is required (`ts/ban-ts-comment`).
- **`bun test` does not type-check.** These assertions are enforced by `pnpm typecheck`, which runs `tsc --noEmit` over `src/` *and* `tests/` (each package's `tsconfig.json` includes `tests`). A change is not verified until both `pnpm test` and `pnpm typecheck` pass.
- Add negative cases whenever you add or change a public generic type or a branded type.

## Determinism

- Tests must give the same result on every run and every machine. Do not depend on wall-clock time, randomness, test order, network access or the developer's environment.
- If code needs time, randomness or I/O, inject it so that tests can pass fixed values.
- For serialization, assert exact output. `canonicalJsonStringify` tests compare complete strings, because byte-identical output is the contract.
- Clean up any files or processes a test creates. Prefer in-memory data over the file system.

## Integration tests of applications

Test an application's event-driven behaviour with `createTestApp` from `@holqa/testing` instead of a hand-built runtime and local environment. It gives each test its own state directory and a virtual clock, so retries, delays and schedules run without waiting for real time:

```ts
import { createTestApp } from "@holqa/testing";
import app from "@/app/infra";
import { processOrder } from "@/app/src/orders.handler";

const test = await createTestApp({ app, handlers: [processOrder] });
test.failNext("orders.process");            // the first attempt throws
await test.send("orders", { orderId: "1" });
await test.drain();                         // moves time to the retry and runs it
expect(test.invocations({ handlerId: "orders.process" }).map(record => record.outcome)).toEqual(["failed", "ok"]);
await test.dispose();
```

An application instance can be bound to one running test app at a time: dispose of it (for example in `afterEach`) before creating the next. `createTestApp` requires Bun. See the [`@holqa/testing` README](../../packages/testing/README.md) and the [order pipeline example](../../examples/order-pipeline/README.md).

Tests that start real processes (the CLI's dev session tests, `examples/order-pipeline/tests/dev-session.test.ts`) write scratch copies of applications under the package's `.tmp/` directory, which is ignored by Git and ESLint, and remove them afterwards.

## No tests is a failure

`bun test` exits non-zero when it finds no test files, so a package's `test` script fails rather than passing vacuously. Every package with a `test` script must contain at least one real test. Do not work around this with an empty placeholder test.

## Package smoke tests

[`examples/package-smoke`](../../examples/package-smoke/) tests the packages *as consumers see them*:

- `tests/package-exports.test.ts` imports `@holqa/core` and `@holqa/compiler` through their `exports` and checks runtime behaviour and exported types.
- `tests/published-artifacts.test.ts` checks that each package's `dist/` contains `.js` and `.d.ts` files with no unresolved `@/` imports ([ADR 0011](../architecture/decisions/0011-path-aliases-in-library-packages.md)), and runs the built `holqa` bin with Bun (`--help`, a usage error, and a proposed command that must report `HOLQA_CLI_NOT_IMPLEMENTED`), and runs an SDK application with `createTestApp`.

It runs in `pnpm test` after the packages are built. When you add a package that produces build output, add it to these tests (see [development: adding a package](development.md#7-wire-it-into-verification-and-docs)).

## What to test

| Area | Examples |
| --- | --- |
| Runtime behaviour | Valid inputs give the expected values, and each documented branch is exercised. |
| Type inference and compile-time contracts | `expectTypeOf` for inferred types, `@ts-expect-error` for misuse that must not compile. |
| Error handling | Each failure produces the documented diagnostic code and severity, or the documented thrown error type. |
| Serialization | Exact output, rejected values, and error paths such as `$.resources[0].id`. |
| Determinism | Equal inputs in different orders produce identical output. |
| Boundary conditions | Empty input, maximum lengths (`maxResourceIdLength` and one more), `null`, `undefined`, `-0`, cycles. |
| Regressions | A failing test reproducing the bug, added before the fix. |

Avoid brittle tests that are tied to implementation details, such as private helper names, the internal order of calls, or snapshots of large unstable structures. If a refactor that keeps behaviour unchanged breaks a test, the test was asserting the wrong thing.
