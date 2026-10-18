import type { CliHost } from "@/analysis/host";
import type { CliIo } from "@/io";

import {
  join,
  resolve
} from "node:path";

import {
  serializeEntrypoints,
  serializeManifest
} from "@holqa/compiler";
import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

import {
  analyzeApplication,
  displayPath,
  reportDiagnostics
} from "@/commands/analysis-command";
import { exitCodes } from "@/exit-codes";

/** Where build output goes when `--out-dir` is not given, relative to the application root. */
export const defaultOutDir = ".holqa/build";

/**
 * Runs `holqa build --manifest`: analyzes the application and writes
 * `manifest.json` and `entrypoints.json` (canonical JSON with a trailing
 * newline) to the output directory. Bundling executable artifacts is planned.
 *
 * @param host - Analyzes the application and writes the files.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param options - The parsed --app and --out-dir values.
 * @param options.app - The `--app` value, if any.
 * @param options.outDir - The `--out-dir` value, if any; relative paths are resolved against the working directory.
 * @returns `0` on success, `1` when analysis or writing fails.
 */
export async function buildCommand(host: CliHost, io: CliIo, json: boolean, options: { readonly app: string | undefined; readonly outDir: string | undefined }): Promise<number> {
  const result = await analyzeApplication(host, io, json, options.app);
  if (result === undefined)
    return exitCodes.failure;
  const { manifest, entrypoints, diagnostics } = result.analysis;
  const outDir = options.outDir === undefined ? join(result.appPath, "..", defaultOutDir) : resolve(host.cwd, options.outDir);
  const manifestPath = join(outDir, "manifest.json");
  const entrypointsPath = join(outDir, "entrypoints.json");
  try {
    await host.writeFile(manifestPath, `${serializeManifest(manifest)}\n`);
    await host.writeFile(entrypointsPath, `${serializeEntrypoints(entrypoints)}\n`);
  } catch (error) {
    reportDiagnostics(io, json, [createDiagnostic({
      code: diagnosticCodes.buildOutputFailed,
      severity: "error",
      message: `Could not write the build output to "${displayPath(host.cwd, outDir)}": ${error instanceof Error ? error.message : String(error)}`,
      hint: "Check that the output directory is writable, or choose another with --out-dir."
    })]);
    return exitCodes.failure;
  }
  io.stdout(json
    ? JSON.stringify({ diagnostics, manifest: { path: displayPath(host.cwd, manifestPath), fingerprint: entrypoints.manifest }, entrypoints: { path: displayPath(host.cwd, entrypointsPath) } })
    : [`Wrote ${displayPath(host.cwd, manifestPath)} (${entrypoints.manifest})`, `Wrote ${displayPath(host.cwd, entrypointsPath)}`].join("\n"));
  return exitCodes.success;
}