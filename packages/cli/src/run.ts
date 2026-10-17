import type { Diagnostic } from "@holqa/core";

import {
  createDiagnostic,
  diagnosticCodes,
  formatDiagnostic
} from "@holqa/core";

import {
  findProposedCommand,
  proposedCommands
} from "@/commands";

/**
 * Output streams used by the CLI. Injected so that the CLI can be tested
 * without touching the real process streams.
 */
export interface CliIo {
  /** Writes text to standard output. */
  readonly stdout: (text: string) => void;
  /** Writes text to standard error. */
  readonly stderr: (text: string) => void;
}

/**
 * Process exit codes returned by {@link runCli}.
 */
export const exitCodes = {
  success: 0,
  /** The command was understood but failed or is unavailable. */
  failure: 1,
  /** The command line could not be understood. */
  usage: 2
} as const;

/**
 * Runs the Holqa CLI against already-split arguments and reports the outcome
 * through `io` and the returned exit code.
 *
 * Supported today: `--help`/`-h` (or no arguments), `--version`/`-v`, and
 * `--json`, which switches error output to a machine-readable JSON document of
 * the form `{ "diagnostics": [...] }` for agents and scripts. Every other
 * command is reported as not implemented (if it is a proposed command) or unknown.
 *
 * This function has no side effects other than calling `io`.
 *
 * @param argv - Arguments after the executable and script name.
 * @param io - Output streams.
 * @param version - The version string reported by `--version`.
 * @returns The process exit code; see {@link exitCodes}.
 */
export function runCli(argv: readonly string[], io: CliIo, version: string): number {
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
 * Writes a diagnostic to standard error as JSON or as human-readable text.
 *
 * @param io - Output streams.
 * @param json - Whether to emit machine-readable JSON.
 * @param diagnostic - The diagnostic to report.
 */
function reportError(io: CliIo, json: boolean, diagnostic: Diagnostic): void {
  io.stderr(json ? JSON.stringify({ diagnostics: [diagnostic] }) : formatDiagnostic(diagnostic));
}

/**
 * Builds the `--help` text, listing proposed commands as not yet implemented.
 *
 * @param version - The CLI version to display.
 * @returns The help text without a trailing newline.
 */
function renderHelp(version: string): string {
  const width = Math.max(...proposedCommands.map(command => command.name.length));
  const commands = proposedCommands
    .map(command => `  ${command.name.padEnd(width)}  ${command.summary}`)
    .join("\n");
  return [
    `holqa ${version}`,
    "",
    "Usage: holqa [--help] [--version] [--json]",
    "",
    "Options:",
    "  -h, --help     Show this help.",
    "  -v, --version  Print the CLI version.",
    "  --json         Emit machine-readable JSON output.",
    "",
    "Proposed commands (not implemented yet):",
    commands
  ].join("\n");
}