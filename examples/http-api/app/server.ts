// Serves the compiled application: run `holqa build --manifest --app app/infra.ts` first
// (the package's `start` script does both).
import {
  createRuntime,
  loadCompiledApplication,
  serve,
  stopOnSignals
} from "@holqa/runtime-bun";

/**
 * Loads the build output next to this file, serves it on `PORT` (default
 * 3000) and stops gracefully on `SIGINT` or `SIGTERM`.
 */
async function main(): Promise<void> {
  const { PORT: port = "3000" } = process.env;
  const runtime = createRuntime(await loadCompiledApplication({ root: import.meta.dir }));
  const server = await serve(runtime, { port: Number(port) });
  stopOnSignals(server);
  process.stdout.write(`Serving ${runtime.name} at ${server.url.href}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});