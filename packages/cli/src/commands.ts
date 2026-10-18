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
  { name: "inspect", summary: "Analyze the application and print its resources, handlers, configuration and graph." },
  { name: "build --manifest", summary: "Write the application's manifest and entry point map." }
];

/**
 * Commands described in the architecture documentation that the CLI will
 * eventually provide. None of them are implemented yet; invoking one reports
 * `HOLQA_CLI_NOT_IMPLEMENTED`.
 */
export const proposedCommands: readonly ProposedCommand[] = [
  { name: "dev", summary: "Run the application locally with emulated resources." },
  { name: "doctor", summary: "Diagnose project configuration and environment problems." },
  { name: "invoke", summary: "Invoke a handler locally with a test event." },
  { name: "queue send", summary: "Send a message to a local queue." },
  { name: "storage put", summary: "Upload an object to local storage." },
  { name: "cron run", summary: "Trigger a scheduled task immediately." },
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