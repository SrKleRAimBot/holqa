# CLI reference

> **Status:** **Implemented** for `--help`, `--version`, `--json`, `holqa inspect` (including `--cycles`), `holqa build --manifest`, `holqa dev`, `holqa invoke`, `holqa queue send`, `holqa queue redrive`, `holqa storage put`, `holqa cron run`, `holqa state`, `holqa doctor` and the telemetry commands `holqa logs`, `holqa traces list`, `holqa traces inspect`, `holqa events inspect` and `holqa metrics`. Bundling executable artifacts (`holqa build` without `--manifest`) and `holqa openapi generate` are **proposed and not implemented**.

The `holqa` binary is provided by `@holqa/cli` (`packages/cli`). It runs on Bun (`#!/usr/bin/env bun`; `engines.bun >= 1.3.13`). The package is private and not published, so the CLI is only available inside this repository.

## Running the CLI

```bash
pnpm build
bun packages/cli/dist/bin.js --help
```

Within the workspace, packages that depend on `@holqa/cli` (such as `examples/package-smoke`) also get the `holqa` bin linked by pnpm.

## Usage

```text
holqa [--help] [--version] [--json]
holqa inspect [--cycles] [--app <path>] [--json]
holqa build --manifest [--app <path>] [--out-dir <dir>] [--json]
holqa dev [--app <path>] [--port <port>] [--host <host>] [--state-dir <dir>] [--no-watch] [--no-hot] [--no-dashboard] [--json]
holqa invoke <handler> [--input <json>] [--attempt <n>] [--app <path>] [--state-dir <dir>] [--json]
holqa queue send <queue> --data <json> [--delay <seconds>] [--app <path>] [--state-dir <dir>] [--json]
holqa queue redrive <queue> [--message <id>] [--limit <n>] [--dry-run] [--new-operation] [--app <path>] [--state-dir <dir>] [--json]
holqa storage put <bucket> <file> [--key <key>] [--content-type <type>] [--app <path>] [--state-dir <dir>] [--json]
holqa cron run <schedule> [--app <path>] [--state-dir <dir>] [--json]
holqa state [--app <path>] [--state-dir <dir>] [--json]
holqa doctor [--app <path>] [--port <port>] [--host <host>] [--state-dir <dir>] [--json]
holqa logs [--follow] [--handler <id>] [--trace <trace-id>] [--level <level>] [--limit <n>] [--app <path>] [--state-dir <dir>] [--json]
holqa traces list [--limit <n>] [--app <path>] [--state-dir <dir>] [--json]
holqa traces inspect <trace-id> [--app <path>] [--state-dir <dir>] [--json]
holqa events inspect <event-id> [--app <path>] [--state-dir <dir>] [--json]
holqa metrics [--app <path>] [--state-dir <dir>] [--json]
```

## Options

| Option | Behavior | Exit code |
| --- | --- | --- |
| (no arguments) | Prints help to standard output. | `0` |
| `-h`, `--help` | Prints help to standard output. Takes precedence over every other argument. | `0` |
| `-v`, `--version` | Prints the CLI version to standard output. | `0` |
| `--json` | Switches output to machine-readable JSON. Can appear anywhere in the argument list. | — |
| `--app <path>` | Every command: the application module, relative to the working directory. Default `infra.ts`. Its directory is the application root. | — |
| `--out-dir <dir>` | `build`: where to write output, relative to the working directory. Default `.holqa/build` in the application root. | — |
| `--manifest` | `build`: write the manifest and entry point map. Required today. | — |
| `--state-dir <dir>` | Local and telemetry commands: the local state directory, relative to the working directory. Default `.holqa/local` in the application root. | — |
| `--port <port>` | `dev`, `doctor`: the dev server's port, `0` to `65535`. Default `3000`; `0` picks a free port. | — |
| `--host <host>` | `dev`, `doctor`: the interface to listen on. Default `127.0.0.1`. | — |
| `--no-watch` | `dev`: do not rebuild on file changes. | — |
| `--no-hot` | `dev`: restart the generation process on every change instead of replacing handlers in place. | — |
| `--no-dashboard` | `dev`: do not serve the development dashboard. | — |
| `--cycles` | `inspect`: print the event dependency graph and its cycles instead of the summary. | — |
| `--follow` | `logs`: keep printing new entries until the process receives `SIGINT` or `SIGTERM`. | — |
| `--handler <id>`, `--trace <trace-id>`, `--level <level>` | `logs`: only entries of one handler, of one trace, or at `debug`, `info`, `warn` or `error` and more severe. | — |
| `--limit <n>` | `logs`, `traces list`: how many entries or traces, `1` to `10000`. Defaults 100 and 20. | — |

Options take their value as `--app path` or `--app=path`. Positional arguments (`<handler>`, `<queue>`, ...) are required and counted exactly; an argument after `--` is always positional. Help text is always plain text, even with `--json`. It lists the implemented commands, then the proposed commands under "Proposed commands (not implemented yet)".

## Commands

> **Every command except `--help`, `--version` and the telemetry commands runs your application's code.** `inspect` and `build` import the application module, every handler module and everything those import, in a separate Bun process with an allowlisted environment. The local commands (`dev`, `invoke`, `queue send`, `queue redrive`, `storage put`, `cron run`, `state`, `doctor`) analyze the same way and then **run** the application in a separate Bun process with the CLI's full environment, as any server you start would, including `.env` files Bun loads from the application root. None of this is a sandbox. See the [security model](compiler-specification.md#security-model).

### `holqa inspect`

Analyzes the application and prints its intended infrastructure: resources with their requirements and contracts, handlers with their triggers and modules, configuration entries, and required capabilities. Warnings, and anything the application's modules print while they are evaluated, go to standard error.

With `--json`, standard output receives one canonical JSON document (keys sorted, two-space indentation):

```ts
interface InspectJsonOutput {
  diagnostics: Diagnostic[]; // warnings; empty when there are none
  entrypoints: EntrypointMap; // holqa.entrypoints/1
  graph: ResourceGraph; // nodes and edges, see the compiler specification
  manifest: Manifest; // manifest version 1
}
```

With `--cycles`, it prints the application's [event dependency graph](../concepts/event-safety.md) instead: every handler with its trigger, analysis coverage, declared limits and publications (operation, target, certainty, the call and its location), then the cycles (reported ones as `warning` or `info`, allowed ones with their justifications), then the publications analysis could not resolve. `HOLQA_EVENT_CYCLE` diagnostics go to standard error like every warning. Cycles do not fail the command: the exit code is `0` whenever analysis succeeds. With `--json`, standard output receives one canonical JSON document:

```ts
interface InspectCyclesJsonOutput {
  cycles: EventCycle[]; // reported first, then allowed; see the compiler specification
  diagnostics: Diagnostic[]; // warnings and information, including HOLQA_EVENT_CYCLE
  events: EventGraph; // nodes, edges and unresolved publications; locations relative to the application root
}
```

### `holqa build --manifest`

Analyzes the application and writes two files, each canonical JSON followed by a newline:

| File | Content |
| --- | --- |
| `manifest.json` | The manifest ([format](compiler-specification.md#manifest-version-1)). |
| `entrypoints.json` | Where each handler is implemented, tied to the manifest by fingerprint ([format](compiler-specification.md#entry-point-map)). |

Standard output names the files and the manifest fingerprint. With `--json` it is one line:

```ts
interface BuildJsonOutput {
  diagnostics: Diagnostic[];
  manifest: { path: string; fingerprint: string }; // "sha256:..."
  entrypoints: { path: string };
}
```

`holqa build` without `--manifest` would bundle executable artifacts, which is **planned**; it exits with `1` and `HOLQA_CLI_NOT_IMPLEMENTED`.

### `holqa dev`

Runs the application locally with the `@holqa/local` binding and rebuilds it when files change. The design is recorded in [ADR 0025](../architecture/decisions/0025-dev-supervisor-and-process-generations.md) and, for hot handler replacement, [ADR 0028](../architecture/decisions/0028-hot-handler-replacement.md); the [local development guide](../guides/local-development.md) walks through it.

| Aspect | Behaviour |
| --- | --- |
| Address | One stable address, `http://127.0.0.1:3000/` by default, serving the application's routes, procedures and local signed URLs. It proxies to the current generation. |
| Generations | Each build runs in a fresh Bun process (a generation) that loads the build from `.holqa/dev/build`, opens the local state in `.holqa/local` and runs one runtime. At most one generation consumes queues, events and schedules. |
| Watching | Changes to `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` and `.json` files outside `node_modules` and dot directories, and to `.env` files in the root, trigger a rebuild after 100 ms without further changes. Changes during a rebuild are collected into one more rebuild. |
| Reloads | Analyze, write the build, prepare the next generation (load, create the runtime, check configuration and capabilities) while the current one serves, then stop the current one gracefully and activate the next. A failure before activation reports `HOLQA_RELOAD_FAILED` and its causes; the current generation keeps serving. |
| Change kinds | `implementation` (manifest unchanged), `handlers`, `resources` (resources or configuration), `environment` (only `.env` files; no analysis), `initial`. None recreates local state. |
| Hot replacement | An `implementation` change whose files are only imported by handler modules (not by the application module), with an unchanged entry point map, is applied in the running generation: the affected handler modules are rebundled into `.holqa/dev/hot/` and their handlers replaced atomically (`handlers.swapped`). Running invocations finish under the previous implementation. Every other change restarts the generation; the `build` event's `reload` says which and why. See the [guide](../guides/local-development.md#how-reloads-work). |
| Restart reasons | `initial`, `requested`, `hot-disabled`, `no-generation`, `environment`, `dependencies` (package manifests, lockfiles, `tsconfig`, `bunfig`), `contract` (manifest changed), `entrypoints` (a handler moved), `application-module`, `unreferenced-module`, `restart-marker` (a module contains `holqa:restart-on-change`), `swap-limit` (50 replacements per process), and, from `handlers.swap-refused`, `side-effects` (new code created timers, listeners, servers or globals while loading) and `replacement-rejected`. |
| Stale code | When a change fails, the last working code keeps serving. Failure events carry `stale: true` while a generation serves, and text output prints a `STALE` line. |
| Queued messages | When a queue's contract changed, the new generation checks the messages waiting in it against the new contract and logs a `HOLQA_QUEUED_MESSAGE_INCOMPATIBLE` warning with counts and up to ten message identifiers. Messages are never changed. |
| Dashboard | A read-only page at `/_holqa/dashboard` with JSON endpoints under `/_holqa/dashboard/api/` (`status`, `state` without message payloads, `logs`, `traces`, `traces/<id>`). Served only when `--host` is a loopback address, only to requests whose `Host` is one, and only for `GET`. `--no-dashboard` turns it off. |
| Contracts | Changed queue message and HTTP request and response schemas are compared with the [compatibility checker](schema-contracts.md); its diagnostics (for example `HOLQA_SCHEMA_CHANGE_BREAKING`) are reported with the build. Compiler errors fail the reload. |
| Requests during a swap | Wait up to 15 seconds for the next generation. Without a running generation they receive `503` with `{ "error": { "code", "message" } }`. |
| Session | `.holqa/dev/session.json` in the application root records the process, address and a bearer token for the control endpoint (mode `0600`). The same record is written to `dev-session.json` in the state directory. A second `holqa dev` for the same application or the same state directory fails with `HOLQA_DEV_SESSION_ACTIVE`. Both files are removed on exit. |
| Stopping | `SIGINT` or `SIGTERM` stops the generation (in-flight invocations get 5 seconds, deliveries are settled or released), closes the server and exits with `0`. |
| Application output | Printed to standard error as `  | <line>` in text mode; `output` events with `--json`. |

Text output lists the generation's resources, handlers with their endpoints and modules, and the next schedule runs, then one line per log entry: time, level, handler, message, outcome code and duration, trigger, attempt, trace (`correlationId`), cause (`causationId`) and emitted events. A failure adds the error's message and the first stack frame in the application.

With `--json`, standard output receives one JSON object per line, tagged with `type`:

| `type` | Fields |
| --- | --- |
| `dev.listening` | `url`, `stateDirectory`, `buildDirectory`, `watching`, `hot`, `dashboard` (its URL, when served) |
| `change` | `files` (relative to the application root) |
| `build` | `generation`, `change` (`kind`, `resources`, `handlers` and `config` as `{ added, removed, changed }`, `contracts`), `fingerprint`, `durationMs`, `diagnostics` (warnings), `reload` (`{ strategy: "swap", modules, handlers }` or `{ strategy: "restart", reason, detail }`) |
| `build.failed` | `diagnostics` (first `HOLQA_RELOAD_FAILED`), `serving` (the generation that keeps serving, when there is one), `stale` |
| `handlers.swapped` | `generation`, `version` (the new registry version), `handlers`, `modules`, `durationMs`, `versions` (every handler's `{ handlerId, version, active, retiring }`) |
| `handlers.swap-failed` | `generation`, `diagnostics`, `serving`, `stale` (the new code failed to load; the previous code keeps serving) |
| `handlers.swap-refused` | `generation`, `reason`, `diagnostics` (the change is valid but cannot be applied in place; a restart follows) |
| `generation.ready` | `generation`, `pid`, `durationMs`, `summary` (`application`, `fingerprint`, `resources`, `handlers`, `schedules`) |
| `generation.failed` | `generation`, `diagnostics`, `serving`, `stale` |
| `generation.stopped`, `generation.exited` | `generation`, `exitCode` (`exited` means the process ended on its own) |
| `log` | `generation`, `entry` (a runtime log entry, see [logs](runtime.md#logs)) |
| `output` | `generation`, `stream`, `line` |
| `dev.stopped` | — |

Consumers should ignore event types and fields they do not know; new ones are added in minor versions. A `build` is no longer always followed by `generation.ready` or `generation.failed`: when its `reload.strategy` is `"swap"`, it repeats the serving generation's number and is followed by `handlers.swapped` or `handlers.swap-failed`, or by `handlers.swap-refused` and then a second `build` with `reload.strategy: "restart"` for the new generation. Tools that waited for `generation.ready` after every `build` must check `reload.strategy`. Log entries of replaced implementations carry `handlerVersion`, shown as `orders.process v2` in text output.

`holqa dev` exits with `1` and diagnostics on standard error when it cannot start (`HOLQA_DEV_SESSION_ACTIVE`, `HOLQA_DEV_START_FAILED` for a port in use). A failing first build does not end the session: it is reported, and the next change rebuilds.

### Operation commands

`invoke`, `queue send`, `queue redrive`, `storage put`, `cron run` and `state` act on the local application. When a `holqa dev` session runs for the same application and state directory, they run in it (`"target": "dev"`), so they share its runtime, module state and logs. Otherwise they analyze and build the application (into `.holqa/dev/operation-build`) and run the operation in a process started for it (`"target": "standalone"`); that process never consumes queues or events, so queued work waits for the next `holqa dev`. While a session runs, an operation never falls back to a standalone process: a session that does not answer reports `HOLQA_LOCAL_OPERATION_FAILED` (the operation may have run), and a session with another state directory reports `HOLQA_DEV_SESSION_ACTIVE`.

| Command | Does | JSON result (standard output) |
| --- | --- | --- |
| `holqa invoke <handler> [--input <json>] [--attempt <n>]` | Invokes a queue consumer, object event handler or schedule handler once, with generated trusted metadata (a first delivery of a new message or event, or a manual run now). The handler validates `--input`. Nothing is recorded in queue, event or schedule history. HTTP routes and procedures are rejected with `HOLQA_OPERATION_INVALID`; call them over HTTP. | `{ target, handlerId, outcome: { ok, handlerId, invocationId, correlationId, durationMs, emitted, value? \| failure? }, logs }` |
| `holqa queue send <queue> --data <json> [--delay <seconds>]` | Validates the message with the queue's schema, as a producer's `send` does, and stores it. | `{ target, queueId, messageId, schemaVersion, delaySeconds? }` |
| `holqa queue redrive <queue> [--message <id>] [--limit <n>] [--dry-run] [--new-operation]` | Makes dead-lettered messages due again with a fresh attempt count, oldest first: all of them, the one `--message` names, or at most `--limit`. `--dry-run` only lists them. Redriven messages keep their [lineage](runtime.md#event-lineage-and-limits), so a message refused for its depth or budget is refused again; `--new-operation` starts a new root operation (depth 0, a fresh budget, a new send time for `maxEventAgeMs`) and a new telemetry trace for each, keeping its correlation. | `{ target, queueId, dryRun, newOperation?, count, messages: [{ messageId, attempts, sentAt, lastError?, trace? }] }` |
| `holqa storage put <bucket> <file> [--key <key>] [--content-type <type>]` | Stores a file (at most 64 MiB) under `--key` (default: the file name), which emits `object.created`. The content type defaults to the one Bun derives from the file extension. | `{ target, bucketId, object: { key, size, contentType?, etag, lastModified } }` |
| `holqa cron run <schedule>` | Starts a manual run through the runtime and the schedule's overlap policy and records it in the schedule's history. | `{ target, scheduleId, run: { runId, status, trigger, ... }, logs }` |
| `holqa state` | Prints the local state: queue messages with their state, attempts, last error and trace; stored objects and object events with each subscription's delivery state; schedule runs and the next cron run. | `{ target, application, queues: [{ id, counts, messages }], buckets: [{ id, objects, events }], schedules: [{ id, cron, timezone, nextRun?, runs }] }` |

A standalone operation also reports what the application printed, as `output` in JSON mode and on standard error in text mode.

| Outcome | Exit code | Standard error with `--json` |
| --- | --- | --- |
| The operation succeeded | `0` | — |
| An invoked handler failed, or a manual run failed | `1` | `{"diagnostics":[...]}`: the failure's code with `details: { handlerId, invocationId, correlationId }` (or `runId`), then its causes, such as `HOLQA_INPUT_INVALID`. Standard output still receives the result. |
| The operation failed (unknown resource or handler, invalid message, the application does not analyze) | `1` | `{"diagnostics":[...]}`, for example `HOLQA_RESOURCE_NOT_FOUND`, `HOLQA_HANDLER_NOT_FOUND`, `HOLQA_INPUT_INVALID`, `HOLQA_OPERATION_INVALID` |
| A file cannot be read | `1` | `HOLQA_FILE_UNREADABLE` |
| The process running the application failed or did not answer | `1` | `HOLQA_LOCAL_OPERATION_FAILED` |
| Malformed arguments, for example `--data` that is not JSON, `--limit 0` or a missing `<queue>` | `2` | `HOLQA_CLI_ARGUMENT_INVALID` |

### `holqa doctor`

Checks the project and the local environment without changing the local state, and prints one line per check (`ok`, `warning` or `error`):

| Check | What it verifies |
| --- | --- |
| `bun` | Bun 1.3.13 or later runs the CLI. |
| `application` | The application module exists. |
| `analysis` | The application analyzes; warnings make it a `warning`. |
| `configuration` | Every configuration entry is set (in the CLI's environment or an `.env` file) or has a default. Secrets are reported by name only. |
| `capabilities` | The local binding provides every resource and can deliver every handler's trigger. |
| `state` | The state directory is readable and its format is supported (`HOLQA_LOCAL_STATE_UNSUPPORTED` otherwise). |
| `session` | Whether a `holqa dev` session runs, or a stale session file was left behind. |
| `port` | The dev port is free (only when no session runs). |

With `--json`, standard output receives `{ checks: [{ name, status, message, diagnostics? }], diagnostics }`. When a check fails, the exit code is `1` and standard error also receives `{"diagnostics":[...]}`, starting with one `HOLQA_DOCTOR_CHECK_FAILED` per failed check.

### Telemetry commands

`logs`, `traces list`, `traces inspect`, `events inspect` and `metrics` read the local telemetry store (`telemetry.sqlite` in the state directory) and, for `events inspect`, the local state, read-only. They neither analyze nor run the application, and they work while a `holqa dev` session writes to the store. `--app` only locates the default state directory.

The store is written by `holqa dev`, `holqa invoke` and `holqa cron run` (`queue send`, `queue redrive`, `storage put` and `state` run no handler). Those commands also export spans and metrics over OTLP/HTTP when the standard OpenTelemetry environment variables configure an endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT` and related variables; see the [observability guide](../guides/observability.md#export-to-an-opentelemetry-collector-or-another-otlp-backend)); unsupported values make the application process fail with `HOLQA_TELEMETRY_CONFIG_INVALID`. The dev session also counts reload failures (`holqa.dev.reload.failures`) in the store.

| Command | Prints | JSON output (standard output) |
| --- | --- | --- |
| `holqa logs` | The newest log entries, oldest first, one formatted line each (the line format of `holqa dev`). With `--follow`, new entries every 500 ms until stopped; a store created after the command started is picked up. | One JSON log entry per line, not one document. |
| `holqa traces list` | A table of recent traces, newest first: trace identifier, start (UTC), duration, span count, error count and root span name. | `{ traces: [{ traceId, name, startTime, durationMs, spans, errors }] }` |
| `holqa traces inspect <trace-id>` | One trace as a tree of spans: kind, offset, a timeline bar, duration, status with `error.type`, exception messages and links to other traces. Accepts an unambiguous prefix of the trace identifier. | `{ traceId, spans }` (the stored `SpanRecord`s) |
| `holqa events inspect <event-id>` | For a message or object event identifier: each delivery's state, attempts, send time, lineage, publishing trace and last error; the invocations that processed it; its spans; its log entries. | `{ id, history?, invocations, logs, spans }` |
| `holqa metrics` | Every framework metric with its series: counter and gauge values; histogram count, average, p50 and p95 upper bucket bounds, and maximum. | `{ metrics }` (the aggregated `MetricRecord`s) |

| Outcome | Exit code | Standard error with `--json` |
| --- | --- | --- |
| Success, including an empty store (`logs`, `traces list` and `metrics` then print that nothing is recorded yet, or empty JSON) | `0` | — |
| `traces inspect` or `events inspect` finds nothing for the identifier | `1` | `HOLQA_TELEMETRY_NOT_FOUND` |
| The telemetry store cannot be read, for example because a newer version wrote it | `1` | The store's diagnostic, for example `HOLQA_LOCAL_STATE_UNSUPPORTED` |
| The host cannot read telemetry or wait for signals (custom hosts) | `1` | `HOLQA_LOCAL_OPERATION_FAILED` |
| A trace identifier prefix that matches several traces, an invalid `--level` or `--limit`, a missing argument | `2` | `HOLQA_CLI_ARGUMENT_INVALID` |

### Paths in output

Diagnostic locations and output paths are relative to the working directory when they lie inside it, and absolute otherwise. The manifest and entry point map themselves only contain paths relative to the application root.

## Behavior for commands

| Input | Result | Exit code | Diagnostic |
| --- | --- | --- | --- |
| `holqa inspect` or `holqa build --manifest` on a valid application | Output on standard output; warnings on standard error. | `0` | Warnings only |
| An application with errors | Every diagnostic on standard error; no manifest is printed or written. | `1` | For example `HOLQA_RESOURCE_NOT_FOUND`, `HOLQA_HANDLER_ID_DUPLICATE` |
| No application module | Error on standard error. | `1` | `HOLQA_APP_NOT_FOUND` |
| Analysis crashes, exits or exceeds 60 seconds | Error on standard error. | `1` | `HOLQA_ANALYSIS_FAILED` |
| Output cannot be written | Error on standard error. | `1` | `HOLQA_BUILD_OUTPUT_FAILED` |
| An unknown option, a missing value, a missing or extra argument or a repeated option for any implemented command | Error on standard error; nothing is analyzed. | `2` | `HOLQA_CLI_ARGUMENT_INVALID` |
| `holqa build` without `--manifest` | Error on standard error. | `1` | `HOLQA_CLI_NOT_IMPLEMENTED` |
| A local command | See [`holqa dev`](#holqa-dev), [operation commands](#operation-commands) and [`holqa doctor`](#holqa-doctor). | `0`, `1` or `2` | — |
| A telemetry command | See [telemetry commands](#telemetry-commands). | `0`, `1` or `2` | — |
| A proposed command (`holqa openapi generate`) | Error on standard error. | `1` | `HOLQA_CLI_NOT_IMPLEMENTED` |
| Anything else (for example `holqa foo`) | Error on standard error. | `2` | `HOLQA_CLI_UNKNOWN_COMMAND` |

An implemented command's words must come first (`queue send orders ...`); `--json` may appear anywhere. Proposed commands are matched by their leading positional words; flags are ignored for matching. Extra positional arguments after a proposed command do not change the result.

## Exit codes

| Code | Name (`exitCodes`) | Meaning |
| --- | --- | --- |
| `0` | `success` | The command succeeded. |
| `1` | `failure` | The command was understood but failed or is unavailable (including not implemented). |
| `2` | `usage` | The command line could not be understood. |

## Output formats

### Human-readable (default)

Diagnostics are written to standard error using `formatDiagnostic`:

```text
$ holqa foo
error HOLQA_CLI_UNKNOWN_COMMAND: Unknown command "foo".
  hint: Run "holqa --help" to list commands.
```

### JSON (`--json`)

Errors are written to standard error as a single-line JSON document, for every command:

```json
{"diagnostics":[{"code":"HOLQA_CLI_NOT_IMPLEMENTED","severity":"error","message":"\"holqa openapi generate\" is a proposed command and is not implemented yet.","hint":"See docs/roadmap.md for implementation status."}]}
```

Shape:

```ts
interface CliJsonErrorOutput {
  diagnostics: Diagnostic[]; // see diagnostic codes reference
}
```

`--version --json` writes `{"version":"<version>"}` to standard output. Successful output of every command is described under [commands](#commands); `holqa dev` and `holqa logs` write JSON lines instead of one document.

Agents and scripts should parse standard error as JSON when the exit code is non-zero and `--json` was passed, then branch on `diagnostics[].code`. See [diagnostic codes](diagnostic-codes.md).

## Proposed commands

> **None of these commands are implemented.** Each one currently exits with code `1` and `HOLQA_CLI_NOT_IMPLEMENTED`. Their names and behavior may change.

| Command | Intended behavior | Roadmap phase |
| --- | --- | --- |
| `holqa build` (without `--manifest`) | Bundle executable artifacts for the runtime. | [Phase 2](../roadmap.md#phase-2-compiler) (remaining) |
| `holqa openapi generate` | Generate an OpenAPI document for HTTP APIs. | [Phase 4](../roadmap.md#phase-4-clients-and-integrations) |

The list is defined in `proposedCommands` (`packages/cli/src/commands.ts`), which also drives the help output; implemented commands are listed in `implementedCommands`. When a command is implemented, it must be moved between the lists, and this page and the [roadmap](../roadmap.md) must be updated in the same change.

## Programmatic use

`runCli(argv, io, version, host?)` runs the CLI without touching process streams and resolves to the exit code. `host` (a `CliHost`) supplies the working directory, analysis and file writing, and optionally `readFile`, `dev`, `operate` and `doctor` for the local commands, and `telemetry`, `deliveryHistory` and `waitForStop` for the telemetry commands (a host without them reports those commands as unavailable with `HOLQA_LOCAL_OPERATION_FAILED`; without `deliveryHistory`, `events inspect` shows telemetry only). It defaults to `createProcessHost()`, which analyzes and runs the application in separate processes. Tests pass an in-memory host:

```ts
import { runCli } from "@holqa/cli";

const output: string[] = [];
const code = await runCli(["openapi", "generate", "--json"], {
  stdout: text => output.push(text),
  stderr: text => output.push(text)
}, "0.0.0");
// code === 1; output[0] is the JSON diagnostics document.
```

`runCli` returned a number synchronously before `inspect` and `build` existed; it now returns a `Promise<number>`.

## Related

- [Compiler specification](compiler-specification.md)
- [Diagnostic codes](diagnostic-codes.md)
- [Packages](packages.md#holqacli)
- [Agent-native development](../concepts/agent-native-development.md)
- [Local development](../concepts/local-development.md)
- [Local development guide](../guides/local-development.md)
- [Observability guide](../guides/observability.md)
- [ADR 0025](../architecture/decisions/0025-dev-supervisor-and-process-generations.md)
- [ADR 0028](../architecture/decisions/0028-hot-handler-replacement.md)
