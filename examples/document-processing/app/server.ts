// Runs the application locally: run `holqa build --manifest --app app/infra.ts` first
// (the package's `start` script does both). State is kept in `.holqa/local`.
import { join } from "node:path";
import { createLocalEnvironment } from "@holqa/local";
import {
  createRuntime,
  loadCompiledApplication
} from "@holqa/runtime-bun";

/**
 * Serves the compiled application on `PORT` (default 3000) with the local
 * binding: queues, objects and schedules live in `.holqa/local`, and signed
 * upload URLs are served by the same server. Stops gracefully on `SIGINT` or `SIGTERM`.
 */
async function main(): Promise<void> {
  const { PORT: port = "3000" } = process.env;
  const compiled = await loadCompiledApplication({ root: import.meta.dir });
  const local = await createLocalEnvironment({
    app: compiled.app,
    directory: join(import.meta.dir, "..", ".holqa", "local"),
    storage: { signedUrlBase: `http://127.0.0.1:${port}/_holqa/storage` }
  });
  const runtime = createRuntime({ ...compiled, binding: local.binding });
  await runtime.start();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(port),
    fetch: request => local.storage.handles(request) ? local.storage.fetch(request) : runtime.fetch(request)
  });
  /** Stops the server, then the runtime, then closes the local state. */
  const stop = async (): Promise<void> => {
    await server.stop();
    await runtime.stop();
    local.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.stdout.write(`Serving ${runtime.name} at ${server.url.href}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});