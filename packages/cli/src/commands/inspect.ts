import type { CliHost } from "@/analysis/host";
import type { CliIo } from "@/io";

import {
  dirname,
  join
} from "node:path";

import {
  buildResourceGraph,
  canonicalJsonStringify
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
import { formatEventInspection } from "@/output/event-inspection";
import { formatInspection } from "@/output/inspection";

/**
 * Runs `holqa inspect`: analyzes the application and prints its intended
 * infrastructure. With `--json`, standard output receives one canonical JSON
 * document `{ diagnostics, entrypoints, graph, manifest }`.
 *
 * With `--cycles`, it prints the event dependency graph and its cycles
 * instead; with `--json` as `{ cycles, diagnostics, events }`, where `events`
 * is the event graph. Cycles are findings, not failures: the exit code is `0`
 * whenever analysis succeeds.
 *
 * @param host - The CLI host.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param app - The `--app` value, if any.
 * @param cycles - Whether to print the event graph and cycles.
 * @returns `0` on success, `1` when analysis reports an error.
 */
export async function inspectCommand(host: CliHost, io: CliIo, json: boolean, app: string | undefined, cycles = false): Promise<number> {
  const result = await analyzeApplication(host, io, json, app);
  if (result === undefined)
    return exitCodes.failure;
  const { manifest, entrypoints, diagnostics, events } = result.analysis;
  if (cycles) {
    if (events === undefined) {
      reportDiagnostics(io, json, [createDiagnostic({ code: diagnosticCodes.analysisFailed, severity: "error", message: "The analysis did not include an event analysis; this CLI host does not support holqa inspect --cycles." })]);
      return exitCodes.failure;
    }
    const root = dirname(result.appPath);
    io.stdout(json
      ? canonicalJsonStringify({ cycles: events.cycles, diagnostics, events: events.graph })
      : formatEventInspection(manifest.application.name, events, location => `${displayPath(host.cwd, join(root, location.file))}${location.line === undefined ? "" : `:${location.line}${location.column === undefined ? "" : `:${location.column}`}`}`));
    return exitCodes.success;
  }
  io.stdout(json
    ? canonicalJsonStringify({ diagnostics, entrypoints, graph: buildResourceGraph(manifest), manifest })
    : formatInspection(manifest, entrypoints));
  return exitCodes.success;
}