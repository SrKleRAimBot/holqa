import type { CliHost } from "@/analysis/host";
import type { CliIo } from "@/io";

import {
  buildResourceGraph,
  canonicalJsonStringify
} from "@holqa/compiler";

import { analyzeApplication } from "@/commands/analysis-command";
import { exitCodes } from "@/exit-codes";
import { formatInspection } from "@/output/inspection";

/**
 * Runs `holqa inspect`: analyzes the application and prints its intended
 * infrastructure. With `--json`, standard output receives one canonical JSON
 * document `{ diagnostics, entrypoints, graph, manifest }`.
 *
 * @param host - The CLI host.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param app - The `--app` value, if any.
 * @returns `0` on success, `1` when analysis reports an error.
 */
export async function inspectCommand(host: CliHost, io: CliIo, json: boolean, app: string | undefined): Promise<number> {
  const result = await analyzeApplication(host, io, json, app);
  if (result === undefined)
    return exitCodes.failure;
  const { manifest, entrypoints, diagnostics } = result.analysis;
  io.stdout(json
    ? canonicalJsonStringify({ diagnostics, entrypoints, graph: buildResourceGraph(manifest), manifest })
    : formatInspection(manifest, entrypoints));
  return exitCodes.success;
}