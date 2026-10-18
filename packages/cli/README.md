# @holqa/cli

The `holqa` command-line interface.

> **Status:** `--help`, `--version`, `--json`, `holqa inspect` and `holqa build --manifest` are implemented. Bundling
> executable artifacts and every other workflow command are proposed and report `HOLQA_CLI_NOT_IMPLEMENTED`. Private
> and unpublished. Runs on Bun.

```bash
pnpm --filter @holqa/cli build
bun packages/cli/dist/bin.js --help
bun packages/cli/dist/bin.js inspect --app path/to/infra.ts          # print resources, handlers, configuration
bun packages/cli/dist/bin.js inspect --app path/to/infra.ts --json   # { diagnostics, entrypoints, graph, manifest }
bun packages/cli/dist/bin.js build --manifest --app path/to/infra.ts # write .holqa/build/manifest.json and entrypoints.json
```

**`inspect` and `build` run your application's code.** They evaluate the application and handler modules in a separate
Bun process that is passed only an allowlisted environment, does not load `.env` files, cannot install packages, and is
killed after a timeout. That limits exposure; it is not a sandbox. See the
[security model](../../docs/reference/compiler-specification.md#security-model).

| Exit code | Meaning |
| --- | --- |
| `0` | Success. Warnings may be printed to standard error. |
| `1` | The command failed (an invalid application, a failed analysis or write) or is not implemented. |
| `2` | Unknown command or invalid options. |

The full reference, including JSON output shapes, is [docs/reference/cli.md](../../docs/reference/cli.md).
