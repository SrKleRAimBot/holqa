# Package smoke test

> **Status:** Runnable. Executed by `pnpm test` and `pnpm check` (and therefore CI).

This private workspace package consumes `@holqa/core`, `@holqa/compiler`, and `@holqa/cli` exactly as an external
project would: through their `package.json` `exports` and built `dist/` output. It verifies that:

- the public entry points resolve and behave correctly, including inferred types (checked by `pnpm typecheck`);
- the emitted JavaScript and `.d.ts` files exist and contain no unresolved `@/` path aliases;
- the built `holqa` binary runs on Bun and emits machine-readable diagnostics.

```bash
pnpm turbo run test --filter=@holqa/example-package-smoke
```
