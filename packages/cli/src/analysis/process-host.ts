import type {
  AnalysisOutcome,
  CliHost
} from "@/analysis/host";

import {
  existsSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  relative
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

import { readAnalysisReport } from "@/analysis/report";

/** Environment variables passed to the analysis process. Everything else, including every secret, is withheld. */
export const forwardedEnvironment = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"] as const;

/** Settings for {@link createProcessHost}. */
export interface ProcessHostOptions {
  /** The working directory; defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** How long analysis may run before the process is killed; defaults to 60 seconds. */
  readonly timeoutMs?: number;
  /** The analysis entry point; defaults to the one shipped next to this module. */
  readonly workerPath?: string;
  /** The Bun executable; defaults to the running one. */
  readonly bunPath?: string;
  /** The environment to filter; defaults to `process.env`. Only {@link forwardedEnvironment} entries are passed on. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** The largest report accepted from the analysis process, in characters. */
const maxReportLength = 64 * 1024 * 1024;

/** How long output is still read after the analysis process has exited. */
const outputGraceMs = 500;

/** The most output kept from the analysis process, in characters. */
const maxCollectedOutput = 1024 * 1024;

/** How much of the analysis process's output a failure diagnostic quotes. */
const maxQuotedOutput = 4000;

/**
 * Creates the host the `holqa` binary uses. Analysis runs in a separate Bun
 * process that:
 *
 * - is passed only an allowlisted environment (`PATH`, `HOME` and temporary
 *   directory variables, plus `TZ=UTC` and `LC_ALL=C`), so secrets and
 *   deployment credentials in the CLI's environment are not handed to the
 *   application's code;
 * - runs with `--no-env-file`, so `.env` files are not loaded, and with
 *   `--no-install`, so evaluation never downloads packages;
 * - starts in the application root with standard input closed;
 * - is killed when it exceeds the timeout or after it has sent its report;
 * - returns its report over IPC, and the report is validated before use.
 *
 * This limits what evaluation is given and how long it can run. It is not a
 * sandbox: the process runs as the same user, so it can still read files
 * (including credential files and, on some systems, other processes'
 * environments) and use the network. Only analyze applications you would also run.
 *
 * @param options - Working directory, timeout and overrides for tests.
 * @returns A host whose `analyze` spawns the analysis process and whose `writeFile` writes to disk.
 */
export function createProcessHost(options: ProcessHostOptions = {}): CliHost {
  const cwd = options.cwd ?? process.cwd();
  return {
    cwd,
    analyze: async (appPath) => {
      if (!existsSync(appPath)) {
        return {
          ok: false,
          output: "",
          diagnostics: [createDiagnostic({
            code: diagnosticCodes.appNotFound,
            severity: "error",
            message: `The application module "${relative(cwd, appPath) || basename(appPath)}" does not exist.`,
            hint: "Run the command in the directory that contains infra.ts, or pass --app <path>."
          })]
        };
      }
      return runWorker(appPath, options);
    },
    writeFile: async (path, contents) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
  };
}

/**
 * Spawns the analysis process for one application and waits for its report.
 *
 * @param appPath - The absolute path of the application module.
 * @param options - Timeout and overrides.
 * @returns The validated outcome, or a `HOLQA_ANALYSIS_FAILED` failure.
 */
async function runWorker(appPath: string, options: ProcessHostOptions): Promise<AnalysisOutcome> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const environment = options.environment ?? process.env;
  const env: Record<string, string> = { TZ: "UTC", LC_ALL: "C" };
  for (const name of forwardedEnvironment) {
    const value = environment[name];
    if (value !== undefined)
      env[name] = value;
  }

  let message: string | undefined;
  let oversized = false;
  const child = Bun.spawn({
    cmd: [options.bunPath ?? process.execPath, "--no-install", "--no-env-file", options.workerPath ?? defaultWorkerPath(), JSON.stringify({ root: dirname(appPath), appModule: basename(appPath) })],
    cwd: dirname(appPath),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ipc: (received) => {
      if (message !== undefined)
        return;
      if (typeof received !== "string" || received.length > maxReportLength)
        oversized = true;
      else
        message = received;
      child.kill();
    }
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const exitCode = await child.exited;
  clearTimeout(timer);
  // A grandchild process can inherit the pipes and keep them open after the
  // analysis process is gone; stop reading shortly after it exits.
  await Promise.race([Promise.all([stdout.done, stderr.done]), new Promise(resolve => setTimeout(resolve, outputGraceMs))]);
  const output = `${stdout.stop()}${stderr.stop()}`;

  if (message !== undefined)
    return readAnalysisReport(message, output);
  const reason = timedOut
    ? `did not finish within ${timeoutMs} ms`
    : oversized ? "sent a report that is too large or not text" : `exited with code ${exitCode} without a report`;
  return {
    ok: false,
    output,
    diagnostics: [createDiagnostic({
      code: diagnosticCodes.analysisFailed,
      severity: "error",
      message: `The analysis process ${reason}.`,
      hint: timedOut
        ? "Module evaluation must not wait for network, timers or input. Keep top-level code free of side effects."
        : "A module may have called process.exit() or crashed the process during evaluation. See the process output in details.output.",
      details: { output: output.slice(-maxQuotedOutput), ...(timedOut ? { timeoutMs } : { exitCode }) }
    })]
  };
}

/**
 * Reads a stream into a bounded text buffer that can be abandoned at any time.
 *
 * @param stream - A pipe of the analysis process.
 * @returns `done`, which settles at the end of the stream, and `stop`, which cancels reading and returns the text read so far (at most the last 1 MiB).
 */
function collect(stream: ReadableStream<Uint8Array>): { readonly done: Promise<void>; readonly stop: () => string } {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  /**
   * Appends chunks until the stream ends or reading is cancelled.
   *
   * @returns Resolves at the end of the stream.
   */
  const pump = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done)
        return;
      text = (text + decoder.decode(value, { stream: true })).slice(-maxCollectedOutput);
    }
  };
  // Cancelling the reader rejects the pending read; that is how reading ends early, not a failure.
  const done = pump().catch(() => undefined);
  return {
    done,
    stop: () => {
      // Cancelling an already finished stream rejects; there is nothing left to read either way.
      reader.cancel().catch(() => undefined);
      return text;
    }
  };
}

/**
 * Locates the analysis entry point: `analyze.js` next to the built CLI, or
 * `worker-entry.ts` next to this module when running from source.
 *
 * @returns The absolute path of the entry point.
 */
function defaultWorkerPath(): string {
  const fromSource = import.meta.url.endsWith(".ts");
  return fileURLToPath(new URL(fromSource ? "./worker-entry.ts" : "./analyze.js", import.meta.url));
}