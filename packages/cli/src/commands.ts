/**
 * Describes a CLI command that is part of Holqa's design but not yet implemented.
 */
export interface ProposedCommand {
  /** The command words, for example `queue send`. */
  readonly name: string;
  /** A one-line summary of the intended behavior. */
  readonly summary: string;
}

/**
 * Commands the CLI implements, with one-line summaries for the help output.
 * `build` is implemented for `--manifest` only; bundling executable
 * artifacts is planned.
 */
export const implementedCommands: readonly ProposedCommand[] = [
  { name: "inspect", summary: "Analyze the application and print its resources, handlers, configuration and graph; --cycles prints its event graph and cycles." },
  { name: "build --manifest", summary: "Write the application's manifest and entry point map." },
  { name: "dev", summary: "Run the application locally with emulated resources, and rebuild on changes." },
  { name: "invoke", summary: "Invoke a queue, object event or schedule handler once with a test input." },
  { name: "queue send", summary: "Send a message to a local queue." },
  { name: "queue redrive", summary: "Redrive (or list, with --dry-run) dead-lettered messages of a local queue." },
  { name: "storage put", summary: "Upload a file to a local bucket." },
  { name: "cron run", summary: "Run a schedule's handler now." },
  { name: "state", summary: "Print local queue messages, objects, events and schedule runs." },
  { name: "doctor", summary: "Check the project, its configuration and the local environment." }
];

/**
 * Commands described in the architecture documentation that the CLI will
 * eventually provide. None of them are implemented yet; invoking one reports
 * `HOLQA_CLI_NOT_IMPLEMENTED`.
 */
export const proposedCommands: readonly ProposedCommand[] = [
  { name: "openapi generate", summary: "Generate an OpenAPI document for HTTP APIs." }
];

/**
 * Finds the proposed command whose words prefix the given positional arguments,
 * preferring the longest match (so `queue send` wins over a hypothetical `queue`).
 *
 * @param positionals - Positional CLI arguments, excluding flags.
 * @returns The matching proposed command, or `undefined` when none matches.
 */
export function findProposedCommand(positionals: readonly string[]): ProposedCommand | undefined {
  let match: ProposedCommand | undefined;
  for (const command of proposedCommands) {
    const words = command.name.split(" ");
    const matches = words.every((word, index) => positionals[index] === word);
    if (matches && (match === undefined || words.length > match.name.split(" ").length))
      match = command;
  }
  return match;
}