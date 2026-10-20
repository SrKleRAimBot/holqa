// Entry point of the analysis process. The CLI spawns it with an allowlisted
// environment, sends the request as the first argument and receives the report
// over IPC, so nothing the application prints can be mistaken for the report.
import { runAnalysis } from "@/analysis/run-analysis";

/**
 * Parses the request, runs the analysis and sends the report to the parent process.
 *
 * @param argument - The JSON-encoded request.
 */
async function main(argument: string | undefined): Promise<void> {
  const request = JSON.parse(argument ?? "{}") as { readonly root?: unknown; readonly appModule?: unknown; readonly bindingsModule?: unknown };
  if (typeof request.root !== "string" || typeof request.appModule !== "string" || (request.bindingsModule !== undefined && typeof request.bindingsModule !== "string"))
    throw new Error("The analysis process needs a request with \"root\", \"appModule\" and optionally \"bindingsModule\".");
  const report = await runAnalysis({ root: request.root, appModule: request.appModule, ...typeof request.bindingsModule === "string" ? { bindingsModule: request.bindingsModule } : {} });
  if (process.send === undefined)
    throw new Error("The analysis process must be started with an IPC channel.");
  process.send(JSON.stringify(report));
}

main(process.argv[2]).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});