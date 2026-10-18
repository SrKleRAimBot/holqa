# CLI reference

> **Status:** **Implemented** for `--help`, `--version`, `--json`, `holqa inspect` and `holqa build --manifest`. Bundling executable artifacts (`holqa build` without `--manifest`) and every other workflow command are **proposed and not implemented**.

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
holqa inspect [--app <path>] [--json]
holqa build --manifest [--app <path>] [--out-dir <dir>] [--json]
```

## Options

| Option | Behavior | Exit code |
| --- | --- | --- |
| (no arguments) | Prints help to standard output. | `0` |
| `-h`, `--help` | Prints help to standard output. Takes precedence over every other argument. | `0` |
| `-v`, `--version` | Prints the CLI version to standard output. | `0` |
| `--json` | Switches output to machine-readable JSON. Can appear anywhere in the argument list. | — |
| `--app <path>` | `inspect`, `build`: the application module, relative to the working directory. Default `infra.ts`. Its directory is the application root. | — |
| `--out-dir <dir>` | `build`: where to write output, relative to the working directory. Default `.holqa/build` in the application root. | — |
| `--manifest` | `build`: write the manifest and entry point map. Required today. | — |

Options take their value as `--app path` or `--app=path`. Help text is always plain text, even with `--json`. It lists the implemented commands, then the proposed commands under "Proposed commands (not implemented yet)".

## Commands

> **`holqa inspect` and `holqa build` run your application's code.** They import the application module, every handler module and everything those import, in a separate Bun process with an allowlisted environment. This is not a sandbox. See the [security model](compiler-specification.md#security-model).

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
| An unknown option, a missing value, an extra argument or a repeated option for `inspect` or `build` | Error on standard error; nothing is analyzed. | `2` | `HOLQA_CLI_ARGUMENT_INVALID` |
| `holqa build` without `--manifest` | Error on standard error. | `1` | `HOLQA_CLI_NOT_IMPLEMENTED` |
| A proposed command (for example `holqa dev`, `holqa queue send`) | Error on standard error. | `1` | `HOLQA_CLI_NOT_IMPLEMENTED` |
| Anything else (for example `holqa foo`) | Error on standard error. | `2` | `HOLQA_CLI_UNKNOWN_COMMAND` |

`inspect` and `build` must be the first argument. Proposed commands are matched by their leading positional words; flags are ignored for matching, and the longest match wins (`queue send` rather than a hypothetical `queue`). Extra positional arguments after a proposed command do not change the result.

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
{"diagnostics":[{"code":"HOLQA_CLI_NOT_IMPLEMENTED","severity":"error","message":"\"holqa dev\" is a proposed command and is not implemented yet.","hint":"See docs/roadmap.md for implementation status."}]}
```

Shape:

```ts
interface CliJsonErrorOutput {
  diagnostics: Diagnostic[]; // see diagnostic codes reference
}
```

`--version --json` writes `{"version":"<version>"}` to standard output. Successful `inspect` and `build` output is described under [commands](#commands).

Agents and scripts should parse standard error as JSON when the exit code is non-zero and `--json` was passed, then branch on `diagnostics[].code`. See [diagnostic codes](diagnostic-codes.md).

## Proposed commands

> **None of these commands are implemented.** Each one currently exits with code `1` and `HOLQA_CLI_NOT_IMPLEMENTED`. Their names and behavior may change.

| Command | Intended behavior | Roadmap phase |
| --- | --- | --- |
| `holqa dev` | Run the application locally with emulated resources. | [Phase 3](../roadmap.md#phase-3-bun-runtime-and-local-development) |
| `holqa build` (without `--manifest`) | Bundle executable artifacts for the runtime. | [Phase 2](../roadmap.md#phase-2-compiler) (remaining) |
| `holqa doctor` | Diagnose project configuration and environment problems. | [Phase 5](../roadmap.md#phase-5-providers-and-bindings) |
| `holqa invoke` | Invoke a handler locally with a test event. | [Phase 3](../roadmap.md#phase-3-bun-runtime-and-local-development) |
| `holqa queue send` | Send a message to a local queue. | [Phase 3](../roadmap.md#phase-3-bun-runtime-and-local-development) |
| `holqa storage put` | Upload an object to local storage. | [Phase 3](../roadmap.md#phase-3-bun-runtime-and-local-development) |
| `holqa cron run` | Trigger a scheduled task immediately. | [Phase 3](../roadmap.md#phase-3-bun-runtime-and-local-development) |
| `holqa openapi generate` | Generate an OpenAPI document for HTTP APIs. | [Phase 4](../roadmap.md#phase-4-clients-and-integrations) |

The list is defined in `proposedCommands` (`packages/cli/src/commands.ts`), which also drives the help output; implemented commands are listed in `implementedCommands`. When a command is implemented, it must be moved between the lists, and this page and the [roadmap](../roadmap.md) must be updated in the same change.

## Programmatic use

`runCli(argv, io, version, host?)` runs the CLI without touching process streams and resolves to the exit code. `host` (a `CliHost`) supplies the working directory, analysis and file writing; it defaults to `createProcessHost()`, which analyzes in a separate process. Tests pass an in-memory host:

```ts
import { runCli } from "@holqa/cli";

const output: string[] = [];
const code = await runCli(["dev", "--json"], {
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
