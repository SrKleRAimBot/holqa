# @holqa/cli

The `holqa` command-line interface.

> **Status:** Implemented: `--help`, `--version`, `--json`, `holqa inspect`, `holqa build --manifest`, `holqa dev`,
> `holqa invoke`, `holqa queue send`, `holqa storage put`, `holqa cron run`, `holqa state` and `holqa doctor`.
> Bundling executable artifacts (`holqa build` without `--manifest`) and `holqa openapi generate` are proposed and
> report `HOLQA_CLI_NOT_IMPLEMENTED`. Private and unpublished. Runs on Bun.

```bash
pnpm --filter @holqa/cli build
bun packages/cli/dist/bin.js --help
bun packages/cli/dist/bin.js inspect --app path/to/infra.ts          # print resources, handlers, configuration
bun packages/cli/dist/bin.js build --manifest --app path/to/infra.ts # write .holqa/build/manifest.json and entrypoints.json
bun packages/cli/dist/bin.js dev --app path/to/infra.ts              # run locally on http://127.0.0.1:3000/, rebuild on changes
bun packages/cli/dist/bin.js invoke orders.process --input '{"orderId":"123"}' --app path/to/infra.ts --json
```

| Command | What it does |
| --- | --- |
| `holqa dev` | Analyzes the application, writes `.holqa/dev/build`, and runs it on Bun with the `@holqa/local` drivers behind one stable address. Watches files, classifies each change (handler code, handlers, resources, environment files), restarts the application process, and reports contract changes. A broken change is reported while the previous generation keeps serving. |
| `holqa invoke <handler>` | Invokes a queue, object event or schedule handler once with `--input` JSON and generated trusted metadata. |
| `holqa queue send <queue>` | Sends `--data` JSON to a local queue, validated against its schema. |
| `holqa storage put <bucket> <file>` | Stores a file in a local bucket (`--key`, `--content-type`), which emits `object.created`. |
| `holqa cron run <schedule>` | Starts a manual run of a schedule through the runtime and its overlap policy. |
| `holqa state` | Prints queue messages and their attempts, stored objects and events, and schedule runs. |
| `holqa doctor` | Checks Bun, the application, its analysis, configuration, local capabilities, the local state, the dev session and the dev port. Never modifies the local state. |

The operation commands send their work to the running `holqa dev` session of the application when there is one
(`"target": "dev"` in JSON output, and the invocation's logs appear in the session), and otherwise start the
application in a process for that one operation (`"target": "standalone"`).

**These commands run your application's code.** `inspect` and `build`, and the analysis step of every other command,
evaluate the application and handler modules in a separate Bun process that is passed only an allowlisted environment,
does not load `.env` files, cannot install packages, and is killed after a timeout. That limits exposure; it is not a
sandbox. `holqa dev` and the operation commands then *run* the application in separate processes with your
environment, like any server you start yourself. See the
[security model](../../docs/reference/compiler-specification.md#security-model).

| Exit code | Meaning |
| --- | --- |
| `0` | Success. Warnings may be printed to standard error. `holqa dev` exits `0` after `SIGINT` or `SIGTERM`. |
| `1` | The command failed (an invalid application, a failed analysis, write or operation, a handler or scheduled run that failed, a failed doctor check) or is not implemented. |
| `2` | Unknown command or invalid options. |

With `--json`, `holqa dev` writes one JSON event per line to standard output; every other command writes one JSON
document, and failures write `{"diagnostics":[...]}` to standard error. The full reference, including the output
shapes, is [docs/reference/cli.md](../../docs/reference/cli.md); the workflow is described in the
[local development guide](../../docs/guides/local-development.md).
