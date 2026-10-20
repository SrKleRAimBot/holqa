import { fileURLToPath } from "node:url";

/** An entry point of a separate CLI process, from source and from the build. */
export interface ProcessEntry {
  /** Relative to `src/commands/`, for running from source. */
  readonly source: string;
  /** Relative to `dist/`, for the built CLI. */
  readonly built: string;
}

/** What a separate process reported. */
export interface ProcessOutcome {
  /** The message it sent over IPC, if any. */
  readonly message?: string;
  readonly exitCode: number;
  /** The end of what it wrote to standard error. */
  readonly errors: string;
}

/**
 * Runs a CLI entry point in a separate Bun process with the CLI's whole
 * environment, for commands that load the user's provider code and need its
 * credentials (`holqa provision`, `holqa providers test`). The process's
 * standard output is passed through; its result arrives over IPC, so nothing
 * it prints can be mistaken for the result. Unlike analysis, this is not
 * isolated from the environment: only run modules the user chose.
 *
 * @param entry - The entry point.
 * @param request - The JSON request, passed as the first argument.
 * @param cwd - The working directory.
 * @returns The IPC message, exit code and standard error.
 */
export async function runTrustedProcess(entry: ProcessEntry, request: unknown, cwd: string): Promise<ProcessOutcome> {
  const fromSource = import.meta.url.endsWith(".ts");
  const path = fileURLToPath(new URL(fromSource ? entry.source : entry.built, import.meta.url));
  let message: string | undefined;
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-install", path, JSON.stringify(request)],
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "pipe",
    ipc: (received) => {
      message ??= typeof received === "string" ? received : undefined;
      child.kill();
    }
  });
  const [exitCode, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { ...message === undefined ? {} : { message }, exitCode, errors: errors.slice(-4_000) };
}