# CLI reference

> **Status:** Implemented for help, version, and `--json` only. `holqa` supports `--help`, `--version`, and `--json`, and reports structured diagnostics for other input. Every workflow command is **proposed and not implemented**.

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
```

## Options

| Option | Behavior | Exit code |
| --- | --- | --- |
| (no arguments) | Prints help to standard output. | `0` |
| `-h`, `--help` | Prints help to standard output. Takes precedence over every other argument. | `0` |
| `-v`, `--version` | Prints the CLI version to standard output. | `0` |
| `--json` | Switches version output and error output to machine-readable JSON. Can appear anywhere in the argument list. | — |

Help text is always plain text, even with `--json`. It lists the proposed commands under "Proposed commands (not implemented yet)".

## Behavior for commands

| Input | Result | Exit code | Diagnostic |
| --- | --- | --- | --- |
| A proposed command (for example `holqa dev`, `holqa queue send`) | Error on standard error. | `1` | `HOLQA_CLI_NOT_IMPLEMENTED` |
| Anything else (for example `holqa foo`) | Error on standard error. | `2` | `HOLQA_CLI_UNKNOWN_COMMAND` |

Proposed commands are matched by their leading positional words; flags are ignored for matching, and the longest match wins (`queue send` rather than a hypothetical `queue`). Extra positional arguments after a proposed command do not change the result.

## Exit codes

| Code | Name (`exitCodes`) | Meaning |
| --- | --- | --- |
| `0` | `success` | The command succeeded. |
| `1` | `failure` | The command was understood but failed or is unavailable (including not implemented). |
| `2` | `usage` | The command line could not be understood. |

## Output formats

### Human-readable (default)

Errors are written to standard error using `formatDiagnostic`:

```text
$ holqa foo
error HOLQA_CLI_UNKNOWN_COMMAND: Unknown command "foo".
  hint: Run "holqa --help" to list commands.
```

### JSON (`--json`)

Errors are written to standard error as a single-line JSON document:

```json
{"diagnostics":[{"code":"HOLQA_CLI_NOT_IMPLEMENTED","severity":"error","message":"\"holqa dev\" is a proposed command and is not implemented yet.","hint":"See docs/roadmap.md for implementation status."}]}
```

Shape:

```ts
interface CliJsonErrorOutput {
  diagnostics: Diagnostic[]; // see diagnostic codes reference
}
```

`--version --json` writes `{"version":"<version>"}` to standard output.

Agents and scripts should parse standard error as JSON when the exit code is non-zero and `--json` was passed, then branch on `diagnostics[].code`. See [diagnostic codes](diagnostic-codes.md).

## Proposed commands

> **None of these commands are implemented.** Each one currently exits with code `1` and `HOLQA_CLI_NOT_IMPLEMENTED`. Their names and behavior may change.

| Command | Intended behavior | Roadmap phase |
| --- | --- | --- |
| `holqa dev` | Run the application locally with emulated resources. | [Phase 3](../roadmap.md#phase-3-bun-runtime-and-local-development) |
| `holqa build` | Compile the application into a manifest and runtime artifacts. | [Phase 2](../roadmap.md#phase-2-compiler) |
| `holqa inspect` | Print the application resource graph. | [Phase 2](../roadmap.md#phase-2-compiler) |
| `holqa doctor` | Diagnose project configuration and environment problems. | [Phase 5](../roadmap.md#phase-5-providers-and-bindings) |
| `holqa invoke` | Invoke a handler locally with a test event. | [Phase 3](../roadmap.md#phase-3-bun-runtime-and-local-development) |
| `holqa queue send` | Send a message to a local queue. | [Phase 3](../roadmap.md#phase-3-bun-runtime-and-local-development) |
| `holqa storage put` | Upload an object to local storage. | [Phase 3](../roadmap.md#phase-3-bun-runtime-and-local-development) |
| `holqa cron run` | Trigger a scheduled task immediately. | [Phase 3](../roadmap.md#phase-3-bun-runtime-and-local-development) |
| `holqa openapi generate` | Generate an OpenAPI document for HTTP APIs. | [Phase 4](../roadmap.md#phase-4-clients-and-integrations) |

The list is defined in `proposedCommands` (`packages/cli/src/commands.ts`), which also drives the help output. When a command is implemented, it must be removed from that list, and this page and the [roadmap](../roadmap.md) must be updated in the same change.

## Programmatic use

`runCli(argv, io, version)` runs the CLI without touching process streams, which is how the CLI is tested:

```ts
import { runCli } from "@holqa/cli";

const output: string[] = [];
const code = runCli(["dev", "--json"], {
  stdout: text => output.push(text),
  stderr: text => output.push(text)
}, "0.0.0");
// code === 1; output[0] is the JSON diagnostics document.
```

## Related

- [Diagnostic codes](diagnostic-codes.md)
- [Packages](packages.md#holqacli)
- [Agent-native development](../concepts/agent-native-development.md)
- [Local development](../concepts/local-development.md)
