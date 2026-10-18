import type { Diagnostic } from "@holqa/core";

import type { CliHost } from "@/analysis/host";
import type { CliIo } from "@/io";

import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

import { createProcessHost } from "@/analysis/process-host";
import { parseOptions } from "@/arguments";
import {
  findProposedCommand,
  implementedCommands,
  proposedCommands
} from "@/commands";
import { reportDiagnostics } from "@/commands/analysis-command";
import { buildCommand } from "@/commands/build";
import { inspectCommand } from "@/commands/inspect";
import { exitCodes } from "@/exit-codes";

export { exitCodes } from "@/exit-codes";
export type { CliIo } from "@/io";

/**
 * Runs the Holqa CLI against already-split arguments and reports the outcome
 * through `io` and the returned exit code.
 *
 * Supported: `--help`/`-h` (or no arguments), `--version`/`-v`,
 * `holqa inspect [--app <path>]`, `holqa build --manifest [--app <path>] [--out-dir <dir>]`,
 * and `--json` anywhere, which switches output to machine-readable JSON.
 * Errors are reported as diagnostics: `{ "diagnostics": [...] }` on standard
 * error with `--json`. Proposed commands report `HOLQA_CLI_NOT_IMPLEMENTED`.
 *
 * `inspect` and `build` evaluate the application's modules through
 * `host.analyze`, which by default runs them in a separate Bun process with an
 * allowlisted environment (see `createProcessHost`). Apart from the host and
 * `io`, the function has no side effects.
 *
 * @param argv - Arguments after the executable and script name.
 * @param io - Output streams.
 * @param version - The version string reported by `--version`.
 * @param host - Process, file-system and analysis access; defaults to `createProcessHost()`.
 * @returns The process exit code; see {@link exitCodes}.
 */
export async function runCli(argv: readonly string[], io: CliIo, version: string, host?: CliHost): Promise<number> {
  const json = argv.includes("--json");
  const args = argv.filter(argument => argument !== "--json");

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout(renderHelp(version));
    return exitCodes.success;
  }
  if (args.includes("--version") || args.includes("-v")) {
    io.stdout(json ? JSON.stringify({ version }) : version);
    return exitCodes.success;
  }

  const [command, ...rest] = args;
  if (command === "inspect" || command === "build") {
    const options = parseOptions(rest, command === "inspect" ? { flags: [], values: ["app"] } : { flags: ["manifest"], values: ["app", "out-dir"] });
    if (!options.ok) {
      reportDiagnostics(io, json, options.problems.map(problem => usageError(`holqa ${command}: ${problem}`, command)));
      return exitCodes.usage;
    }
    const app = options.values.get("app");
    if (command === "inspect")
      return inspectCommand(host ?? createProcessHost(), io, json, app);
    if (!options.flags.has("manifest")) {
      reportError(io, json, createDiagnostic({
        code: diagnosticCodes.cliNotImplemented,
        severity: "error",
        message: "\"holqa build\" without --manifest would bundle executable artifacts, which is planned and not implemented yet.",
        hint: "Run \"holqa build --manifest\" to write the manifest and entry point map."
      }));
      return exitCodes.failure;
    }
    return buildCommand(host ?? createProcessHost(), io, json, { app, outDir: options.values.get("out-dir") });
  }

  const positionals = args.filter(argument => !argument.startsWith("-"));
  const proposed = findProposedCommand(positionals);
  if (proposed !== undefined) {
    reportError(io, json, createDiagnostic({
      code: diagnosticCodes.cliNotImplemented,
      severity: "error",
      message: `"holqa ${proposed.name}" is a proposed command and is not implemented yet.`,
      hint: "See docs/roadmap.md for implementation status."
    }));
    return exitCodes.failure;
  }

  reportError(io, json, createDiagnostic({
    code: diagnosticCodes.cliUnknownCommand,
    severity: "error",
    message: `Unknown command "${args.join(" ")}".`,
    hint: "Run \"holqa --help\" to list commands."
  }));
  return exitCodes.usage;
}

/**
 * Builds a `HOLQA_CLI_ARGUMENT_INVALID` error.
 *
 * @param message - What is wrong with the arguments.
 * @param command - The command whose arguments were rejected.
 * @returns The diagnostic.
 */
function usageError(message: string, command: string): Diagnostic {
  return createDiagnostic({ code: diagnosticCodes.cliArgumentInvalid, severity: "error", message, hint: `Run "holqa --help" for the options of "holqa ${command}".` });
}

/**
 * Writes one diagnostic to standard error as JSON or as human-readable text.
 *
 * @param io - Output streams.
 * @param json - Whether to emit machine-readable JSON.
 * @param diagnostic - The diagnostic to report.
 */
function reportError(io: CliIo, json: boolean, diagnostic: Diagnostic): void {
  reportDiagnostics(io, json, [diagnostic]);
}

/**
 * Builds the `--help` text: implemented commands with their options, then
 * proposed commands marked as not implemented.
 *
 * @param version - The CLI version to display.
 * @returns The help text without a trailing newline.
 */
function renderHelp(version: string): string {
  const width = Math.max(...[...implementedCommands, ...proposedCommands].map(command => command.name.length));
  /**
   * Renders commands as aligned help lines.
   *
   * @param commands - The commands to list.
   * @returns One indented line per command.
   */
  const list = (commands: typeof proposedCommands): string => commands.map(command => `  ${command.name.padEnd(width)}  ${command.summary}`).join("\n");
  return [
    `holqa ${version}`,
    "",
    "Usage: holqa [--help] [--version] [--json]",
    "       holqa inspect [--app <path>] [--json]",
    "       holqa build --manifest [--app <path>] [--out-dir <dir>] [--json]",
    "",
    "Options:",
    "  -h, --help        Show this help.",
    "  -v, --version     Print the CLI version.",
    "  --json            Emit machine-readable JSON output.",
    "  --app <path>      The application module (default: infra.ts).",
    "  --out-dir <dir>   Where build writes its output (default: .holqa/build next to the application module).",
    "",
    "Commands:",
    list(implementedCommands),
    "",
    "inspect and build evaluate the application's modules, which runs their code.",
    "",
    "Proposed commands (not implemented yet):",
    list(proposedCommands)
  ].join("\n");
}