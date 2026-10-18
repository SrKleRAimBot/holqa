import type { Diagnostic } from "@holqa/core";

import type {
  AnalysisSuccess,
  CliHost
} from "@/analysis/host";
import type { CliIo } from "@/io";

import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import {
  createDiagnostic,
  formatDiagnostic
} from "@holqa/core";

/** The application module analyzed when `--app` is not given. */
export const defaultAppModule = "infra.ts";

/**
 * Analyzes the application named by `--app` (default `infra.ts` in the working
 * directory) and reports its diagnostics. Warnings are written to standard
 * error in human mode; in JSON mode the caller includes them in its document.
 * On failure every diagnostic is written to standard error, as text or as one
 * `{"diagnostics":[...]}` JSON line.
 *
 * @param host - The CLI host.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param app - The `--app` value, if any.
 * @returns The successful analysis (diagnostic locations relative to the working directory) and the application module's absolute path, or `undefined` after reporting failure.
 */
export async function analyzeApplication(host: CliHost, io: CliIo, json: boolean, app: string | undefined): Promise<{ readonly analysis: AnalysisSuccess; readonly appPath: string } | undefined> {
  const appPath = resolve(host.cwd, app ?? defaultAppModule);
  const outcome = await host.analyze(appPath);
  if (!json && outcome.output !== "")
    io.stderr(outcome.output.trimEnd());
  const diagnostics = outcome.diagnostics.map(diagnostic => diagnostic.location === undefined
    ? diagnostic
    : createDiagnostic({ ...diagnostic, location: { ...diagnostic.location, file: displayPath(host.cwd, join(dirname(appPath), diagnostic.location.file)) } }));
  if (!outcome.ok) {
    reportDiagnostics(io, json, diagnostics);
    return undefined;
  }
  if (!json && diagnostics.length > 0)
    io.stderr(diagnostics.map(formatDiagnostic).join("\n"));
  return { analysis: { ...outcome, diagnostics }, appPath };
}

/**
 * Formats a path for CLI output: relative to the working directory with `/`
 * separators when it lies inside it, absolute otherwise. Manifests and entry
 * point maps keep their root-relative paths; only messages use this form.
 *
 * @param cwd - The working directory.
 * @param path - An absolute path.
 * @returns The display form.
 */
export function displayPath(cwd: string, path: string): string {
  const fromCwd = relative(cwd, path);
  return fromCwd === "" || fromCwd.startsWith("..") || isAbsolute(fromCwd) ? path : fromCwd.split(sep).join("/");
}

/**
 * Writes diagnostics to standard error as text, or as a single-line `{"diagnostics":[...]}` JSON document.
 *
 * @param io - Output streams.
 * @param json - Whether to emit machine-readable JSON.
 * @param diagnostics - The diagnostics to report.
 */
export function reportDiagnostics(io: CliIo, json: boolean, diagnostics: readonly Diagnostic[]): void {
  io.stderr(json ? JSON.stringify({ diagnostics }) : diagnostics.map(formatDiagnostic).join("\n"));
}