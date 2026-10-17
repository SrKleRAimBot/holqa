# Tests and quality gates

- Add or update tests for every new behavior, bug fix, and public type. A change without tests needs a stated reason.
- Put tests under `<package>/tests/`, mirroring `src/`: `src/a/b.ts` → `tests/a/b.test.ts`. Never place `*.test.ts` or `*.spec.ts` under `src/` (ESLint and `boundaries:check` reject it).
- Import the module under test with `@/` paths inside a package. Examples import packages by their public names.
- Use `bun:test` (`describe`, `it`, `it.each`, `expect`, `expectTypeOf`, `mock`, `spyOn`). Use `expectTypeOf` and `@ts-expect-error` for compile-time contracts; `tsc` (via `pnpm typecheck`) is what enforces them.
- Keep tests deterministic: no real network, no wall-clock or random dependence without injection, no reliance on test order, no shared mutable state between tests.
- Assert on public behavior and diagnostic codes, not on private implementation details or full human-readable messages unless the message is the contract.
- Never delete, skip (`it.skip`, `it.todo`), or weaken a failing test to get a green run without explaining why in the change summary.
- A package with a `test` script must contain at least one test file; `bun test` exits non-zero when it finds none. Do not add placeholder tests to satisfy this.
- Before declaring a task done, run the narrowest relevant gate, then `pnpm check` (build, typecheck, lint, test, agents:check, boundaries:check):

```bash
pnpm turbo run test --filter=...@holqa/core   # targeted: core and every package that depends on it
pnpm check                                    # full gate
```

- Report validation honestly: quote the commands you ran and their real outcome. Never claim a command passed if you did not run it or if it failed. If you could not run a check, say so and why.
- Do not modify lint rules, tsconfig strictness, or turbo inputs to make a gate pass.

See the `testing` and `code-quality` skills and [docs/contributing/testing.md](../../docs/contributing/testing.md).
