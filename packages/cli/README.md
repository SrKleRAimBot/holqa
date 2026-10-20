# @holqa/cli

The `holqa` command-line interface.

> **Status:** Implemented: `--help`, `--version`, `--json`, `holqa inspect` (with `--cycles`), `holqa build --manifest`,
> `holqa dev`, `holqa invoke`, `holqa queue send`, `holqa queue redrive`, `holqa storage put`, `holqa cron run`,
> `holqa state`, `holqa doctor`, and the telemetry commands `holqa logs`, `holqa traces list`, `holqa traces inspect`,
> `holqa events inspect` and `holqa metrics`.
> Bundling executable artifacts (`holqa build` without `--manifest`) and `holqa openapi generate` are proposed and
> report `HOLQA_CLI_NOT_IMPLEMENTED`. Private and unpublished. Runs on Bun.

```bash
pnpm --filter @holqa/cli build
bun packages/cli/dist/bin.js --help
bun packages/cli/dist/bin.js inspect --app path/to/infra.ts          # print resources, handlers, configuration
bun packages/cli/dist/bin.js inspect --cycles --app path/to/infra.ts # print the event graph and its cycles
bun packages/cli/dist/bin.js build --manifest --app path/to/infra.ts # write .holqa/build/manifest.json and entrypoints.json
bun packages/cli/dist/bin.js dev --app path/to/infra.ts              # run locally on http://127.0.0.1:3000/, rebuild on changes
bun packages/cli/dist/bin.js invoke orders.process --input '{"orderId":"123"}' --app path/to/infra.ts --json
```

| Command | What it does |
| --- | --- |
| `holqa dev` | Analyzes the application, writes `.holqa/dev/build`, and runs it on Bun with the `@holqa/local` drivers behind one stable address. Watches files and classifies each change: handler code is replaced in the running process (hot handler replacement; in-flight work finishes on the old code), everything else restarts the application process; contract changes are reported. A broken change is reported while the last working code keeps serving, flagged as stale. Serves a read-only dashboard at `/_holqa/dashboard` on loopback addresses. `--no-hot` restarts on every change; `--no-dashboard` turns the dashboard off. |
| `holqa invoke <handler>` | Invokes a queue, object event or schedule handler once with `--input` JSON and generated trusted metadata. |
| `holqa queue send <queue>` | Sends `--data` JSON to a local queue, validated against its schema. |
| `holqa queue redrive <queue>` | Redrives dead-lettered messages (`--message`, `--limit`), lists them with `--dry-run`, or gives each a fresh lineage with `--new-operation`. |
| `holqa storage put <bucket> <file>` | Stores a file in a local bucket (`--key`, `--content-type`), which emits `object.created`. |
| `holqa cron run <schedule>` | Starts a manual run of a schedule through the runtime and its overlap policy. |
| `holqa state` | Prints queue messages and their attempts, stored objects and events, and schedule runs. |
| `holqa logs` | Prints recent structured log entries of local runs (`--handler`, `--trace`, `--level`, `--limit`); `--follow` keeps printing new ones. |
| `holqa traces list`, `holqa traces inspect <trace-id>` | Lists recent traces; prints one as a tree of spans with a timeline (an unambiguous prefix of the identifier is enough). |
| `holqa events inspect <event-id>` | Prints a queue message's or object event's deliveries, lineage, last error, invocations, logs and spans. |
| `holqa metrics` | Prints the framework metrics of local runs. |
| `holqa doctor` | Checks Bun, the application, its analysis, configuration, local capabilities, the local state, the dev session and the dev port. Never modifies the local state. |

The operation commands send their work to the running `holqa dev` session of the application when there is one
(`"target": "dev"` in JSON output, and the invocation's logs appear in the session), and otherwise start the
application in a process for that one operation (`"target": "standalone"`).

`holqa dev`, `holqa invoke` and `holqa cron run` record spans, logs and metrics in the local telemetry store
(`telemetry.sqlite` in the state directory), which the telemetry commands read without running the application. When
`OTEL_EXPORTER_OTLP_ENDPOINT` (or another supported `OTEL_*` variable) is set, they also export over OTLP/HTTP through
[`@holqa/opentelemetry`](../integrations/opentelemetry/README.md). See the
[observability guide](../../docs/guides/observability.md).

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

With `--json`, `holqa dev` writes one JSON event per line and `holqa logs` one log entry per line to standard output; every other command writes one JSON
document, and failures write `{"diagnostics":[...]}` to standard error. The full reference, including the output
shapes, is [docs/reference/cli.md](../../docs/reference/cli.md); the workflow is described in the
[local development guide](../../docs/guides/local-development.md).
