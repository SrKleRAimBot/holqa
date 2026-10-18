# Manifest example

> **Status:** **Implemented.** Executed by `pnpm test` and `pnpm check` (and therefore CI).

A private workspace package that compiles applications written with `@holqa/sdk` and Zod through the **built** `holqa`
binary, exactly as a user would run it. It is the acceptance test of the compiler milestone. See the
[compiler specification](../../docs/reference/compiler-specification.md).

| Application | What it shows |
| --- | --- |
| [`apps/shop`](apps/shop/infra.ts) | A queue with a transforming Zod message, a dead-letter requirement and a consumer; a bucket with an object-created handler; a schedule; an HTTP API; a secret and a variable. Resources are split across modules and composed. |
| [`apps/shop-renamed`](apps/shop-renamed/infra.ts) | The same application after a refactor: every variable, alias, file and export name changed and declarations reordered, with every `id` kept. |
| [`apps/invalid`](apps/invalid/infra.ts) | A duplicated handler identifier, a handler for a queue that is not declared, and configuration read at module top level. |

| Test ([`tests/cli.test.ts`](tests/cli.test.ts)) | Asserts |
| --- | --- |
| Golden manifest | `holqa build --manifest` writes [`expected/shop.manifest.json`](expected/shop.manifest.json), which `validateManifest` accepts. |
| Reproducibility | Separate processes, another working directory and a copy of the application at another absolute path produce byte-identical manifests and entry point maps. No machine-specific path appears in either. |
| Rename independence | `shop-renamed` produces the same manifest bytes; only the entry point map changes. |
| Inspection | `holqa inspect --json` lists resources, configuration and trigger edges, and a secret set in the CLI's environment appears nowhere in the output. |
| Diagnostics | `apps/invalid` fails with `HOLQA_RESOURCE_NOT_FOUND`, `HOLQA_MODULE_EVALUATION_FAILED` (citing `HOLQA_RUNTIME_NOT_BOUND`) and `HOLQA_HANDLER_ID_DUPLICATE`, each with a location and a hint; a missing `infra.ts` fails with `HOLQA_APP_NOT_FOUND`. |

```bash
pnpm turbo run test --filter=@holqa/example-manifest
```

To refresh the golden manifest after an intended change, run the tests with `HOLQA_UPDATE_GOLDEN=1` and review the diff.
