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
  { name: "inspect", summary: "Analyze the application and print its resources, handlers, configuration and graph; --cycles prints its event graph and cycles, --capabilities its required capabilities." },
  { name: "bindings inspect", summary: "Show which provider binds each resource and service, why it was selected, and how it meets each requirement." },
  { name: "bindings validate", summary: "Check a binding configuration: providers, contract versions, capabilities, topology and credentials." },
  { name: "build --manifest", summary: "Write the application's manifest and entry point map." },
  { name: "package", summary: "Bundle the application for a binding configuration into a deployment artifact: server.js, manifests, static files, a Dockerfile and file hashes." },
  { name: "dev", summary: "Run the application locally with emulated resources, and rebuild on changes." },
  { name: "invoke", summary: "Invoke a queue, object event or schedule handler once with a test input." },
  { name: "queue send", summary: "Send a message to a local queue." },
  { name: "queue redrive", summary: "Redrive (or list, with --dry-run) dead-lettered messages of a local queue." },
  { name: "storage put", summary: "Upload a file to a local bucket." },
  { name: "cron run", summary: "Run a schedule's handler now." },
  { name: "state", summary: "Print local queue messages, objects, events and schedule runs." },
  { name: "doctor", summary: "Check the project, its configuration and the local environment." },
  { name: "logs", summary: "Print recent structured log entries of local runs; --follow keeps printing new ones." },
  { name: "traces list", summary: "List recent traces recorded by local runs." },
  { name: "traces inspect", summary: "Print one trace as a tree of spans with a timeline." },
  { name: "events inspect", summary: "Print a queue message's or object event's deliveries, lineage, invocations, logs and spans." },
  { name: "metrics", summary: "Print the framework metrics of local runs." }
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