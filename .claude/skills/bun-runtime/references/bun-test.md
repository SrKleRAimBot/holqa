# bun:test quick reference for Holqa

All examples follow the repository's ESLint style (double quotes, semicolons, multiline imports for 2+ specifiers, `@/` imports, no trailing newline in `.ts` files).

## Imports

```ts
import type { ResourceId } from "@/identity/resource-id";

import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  it,
  mock,
  setSystemTime,
  spyOn
} from "bun:test";

import { parseResourceId } from "@/identity/resource-id";
```

Type imports come first in their own statement; `perfectionist/sort-imports` orders the rest. Run `pnpm lint:fix` rather than ordering by hand.

## Table-driven tests

```ts
it.each([
  "orders",
  "order-processing",
  "orders.process"
])("accepts %p", (candidate) => {
  expect(parseResourceId(candidate)).toEqual({ ok: true, value: candidate as ResourceId });
});
```

## Type-level assertions

```ts
it("brands successful values", () => {
  const result = parseResourceId("orders");
  if (result.ok)
    expectTypeOf(result.value).toEqualTypeOf<ResourceId>();

  // @ts-expect-error A plain string is not a validated ResourceId.
  const unvalidated: ResourceId = "orders";
  expect(unvalidated).toBe("orders");
});
```

`expectTypeOf` does nothing at runtime. `pnpm typecheck` fails if the types differ or if a `@ts-expect-error` line stops producing an error.

## Mocks and spies

```ts
it("writes help to stdout", () => {
  const stdout = mock((_text: string) => {});
  const stderr = mock((_text: string) => {});
  runCli(["--help"], { stdout, stderr }, "0.0.0");
  expect(stdout).toHaveBeenCalledTimes(1);
  expect(stderr).not.toHaveBeenCalled();
});
```

- `spyOn(object, "method")` wraps an existing method; call `mock.restore()` in `afterEach` to undo spies.
- `mock.module("specifier", () => ({ ... }))` replaces a module for subsequent imports. Use it sparingly: it couples tests to module structure. Prefer injecting dependencies (as `runCli` does with `CliIo`).

## Time

```ts
afterEach(() => {
  setSystemTime();
});

it("uses a fixed clock", () => {
  setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  expect(new Date().toISOString()).toBe("2026-01-01T00:00:00.000Z");
});
```

## Spawning built binaries

`examples/package-smoke/tests/published-artifacts.test.ts` runs the built CLI:

```ts
const result = Bun.spawnSync(["bun", bin, "dev", "--json"]);
expect(result.exitCode).toBe(1);
```

Only do this in examples or tests for runtime packages; it requires a prior build (Turborepo's `^build` handles this).

## Useful CLI flags

| Flag | Effect |
| --- | --- |
| `--watch` | Re-run on file changes (`test:watch` script). |
| `-t <pattern>` / `--test-name-pattern` | Run tests whose names match. |
| `--bail[=<n>]` | Stop after the first (or `n`th) failure. |
| `--timeout <ms>` | Per-test timeout (default 5000 ms). |
| `--rerun-each <n>` | Re-run each test file `n` times; useful to expose flakiness and order dependence. |
| `--coverage` | Print coverage. Not a repository gate today. |

`it.only`/`describe.only` must never be committed; `it.skip`/`it.todo` need a stated reason.
