# Examples

Holqa is at the bootstrap stage. `package-smoke`, `schema-evolution` and `manifest` run against the implemented packages, and `commerce` runs against the disposable M0 experiment packages. The others show the intended application structure using the **proposed** SDK API, which is not implemented and may change.

| Example | Status | Runs? | Purpose |
| --- | --- | --- | --- |
| [`package-smoke`](./package-smoke/) | **Implemented** | Yes, in CI via `pnpm test` | Consumes the built `@holqa/core`, `@holqa/compiler`, `@holqa/cli`, `@holqa/sdk`, `@holqa/testing` and `@holqa/zod` packages through their public exports. |
| [`schema-evolution`](./schema-evolution/) | **Implemented** | Yes, in CI via `pnpm test` | One Zod message schema validated on publish and receipt, normalized, fingerprinted and checked for compatible evolution. |
| [`manifest`](./manifest/) | **Implemented** | Yes, in CI via `pnpm test` | Applications written with the SDK and Zod, compiled by the built `holqa` CLI: golden manifest, reproducibility, rename independence and diagnostics. |
| [`commerce`](./commerce/) | Runs against the M0 experiments (not the framework) | Yes, in CI via `pnpm test` | The recurring development reference: HTTP routes, two queues, a storage event and a schedule. Type-checked and tested with the prototype SDK, compiler and runtime. |
| [`basic-backend`](./basic-backend/) | Illustrative | No | Backend-only application: HTTP route, queue consumer, storage event handler and scheduled task. |
| [`fullstack-vite`](./fullstack-vite/) | Illustrative | No | Vite frontend calling typed RPC procedures through a generated, browser-safe client with TanStack Query options. |

## `package-smoke`

`@holqa/example-package-smoke` is a private workspace package. Its tests (run with `bun test`) verify that:

- `parseResourceId` from `@holqa/core` and `canonicalJsonStringify` from `@holqa/compiler` work when imported from the built `dist/` output, with the expected types.
- No emitted `.js` or `.d.ts` file in `dist/` contains an unresolved `@/` path alias.
- The built `holqa` bin runs under Bun, prints help, and reports structured diagnostics.
- The built compiler compiles an SDK application, and the manifest JSON Schemas and the CLI's analysis entry point are part of the build output.

Run it with the rest of the test suite:

```sh
pnpm test
# or only this example (builds its dependencies first)
pnpm turbo run test --filter=@holqa/example-package-smoke
```

## Illustrative examples

`basic-backend` and `fullstack-vite` describe how a Holqa application is intended to look once `@holqa/sdk`, the compiler and the local runtime exist. They:

- Have **no `package.json`**, so they are not workspace packages and are never installed, built or tested.
- Are **not type-checked or executed**. Every `.ts` file starts with a comment saying so.
- **Are linted** by the repository ESLint configuration (`pnpm lint:repo`) so that they follow the same code style as the rest of the repository.

Do not copy them into a real project expecting them to work. See [`docs/roadmap.md`](../docs/roadmap.md) for what is planned and [`docs/architecture/status-model.md`](../docs/architecture/status-model.md) for how status is labelled.
