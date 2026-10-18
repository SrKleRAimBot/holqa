# Package smoke test

> **Status:** Runnable. Executed by `pnpm test` and `pnpm check` (and therefore CI).

This private workspace package consumes `@holqa/core`, `@holqa/compiler`, `@holqa/cli`, `@holqa/runtime-bun`,
`@holqa/local`, `@holqa/sdk`, `@holqa/testing` and `@holqa/zod` exactly as an external project would: through their `package.json` `exports` and built `dist/` output. It verifies that:

- the public entry points resolve and behave correctly, including inferred types (checked by `pnpm typecheck`), and
  an SDK queue message is delivered through the built `@holqa/local` binding;
- the emitted JavaScript and `.d.ts` files exist and contain no unresolved `@/` path aliases;
- the built `holqa` binary runs on Bun and emits machine-readable diagnostics.

```bash
pnpm turbo run test --filter=@holqa/example-package-smoke
```
