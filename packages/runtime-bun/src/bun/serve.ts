import type {
  Runtime,
  StopOptions
} from "@/runtime/create-runtime";

/** Settings of {@link serve}. */
export interface ServeOptions {
  /** The TCP port; `0` picks a free one. Default 3000. */
  readonly port?: number;
  /** The interface to listen on. Default `127.0.0.1`, so nothing is exposed beyond the machine unless asked for. */
  readonly hostname?: string;
  /** The largest request body Bun accepts, in bytes. Default 1 MiB. Larger bodies are rejected by Bun with `413`. */
  readonly maxRequestBodySize?: number;
  /** Seconds a connection may stay idle. Default Bun's (10). Streaming responses that pause longer need a higher value. */
  readonly idleTimeoutSeconds?: number;
}

/** A running HTTP server for one runtime. */
export interface RunningServer {
  /** The address the server listens on, for example `http://127.0.0.1:3000/`. */
  readonly url: URL;
  /** The port the server listens on. */
  readonly port: number;
  /**
   * Stops the runtime gracefully (in-flight invocations get the grace
   * period; new requests are answered with `503`), waits up to the force
   * period for responses still being written, and then closes every
   * connection. Idempotent.
   */
  readonly stop: (options?: StopOptions) => Promise<void>;
}

/** Default request body limit: 1 MiB. */
const defaultMaxRequestBodySize = 1024 * 1024;

/**
 * Serves a runtime over HTTP with `Bun.serve`. Starts the runtime first when
 * it has not been started. Requests go through the runtime's `fetch`, so
 * routing, middleware, validation, limits and logging are the runtime's;
 * Bun only supplies the HTTP server.
 *
 * Bun-specific: uses `Bun.serve` (stable in Bun 1.3). Node consumers must use
 * `runtime.fetch` with their own Fetch-compatible server instead.
 *
 * @example
 * ```ts
 * const runtime = createRuntime(await loadCompiledApplication({ root: import.meta.dir }));
 * const server = await serve(runtime, { port: 3000 });
 * stopOnSignals(server);
 * ```
 *
 * @param runtime - The runtime to serve.
 * @param options - Port, interface and request limits.
 * @returns The running server.
 * @throws {HolqaError} When the runtime fails to start (`HOLQA_RUNTIME_START_FAILED`); and whatever `Bun.serve` throws, for example when the port is in use.
 */
export async function serve(runtime: Runtime, options: ServeOptions = {}): Promise<RunningServer> {
  if (runtime.state === "idle")
    await runtime.start();
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: options.port ?? 3000,
      hostname: options.hostname ?? "127.0.0.1",
      maxRequestBodySize: options.maxRequestBodySize ?? defaultMaxRequestBodySize,
      ...options.idleTimeoutSeconds === undefined ? {} : { idleTimeout: options.idleTimeoutSeconds },
      fetch: request => runtime.fetch(request)
    });
  } catch (error) {
    await runtime.stop();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return Object.freeze({
    url: server.url,
    port: server.port ?? options.port ?? 3000,
    stop: (stopOptions?: StopOptions) => {
      stopping ??= (async () => {
        // Drain the runtime first. Meanwhile the server keeps listening and
        // the stopping runtime answers new requests with 503, which load
        // balancers understand. Then let responses that are still being
        // written finish within the force period, and close every
        // connection. (`stop(false)` is not used: on Bun 1.3.13 it leaves
        // keep-alive connections open even after a later `stop(true)`.)
        await runtime.stop(stopOptions);
        const deadline = performance.now() + (stopOptions?.forceMs ?? 1_000);
        while (server.pendingRequests > 0 && performance.now() < deadline)
          await Bun.sleep(5);
        await server.stop(true);
      })();
      return stopping;
    }
  });
}

/**
 * Stops a server gracefully when the process receives a termination signal,
 * as process managers and container platforms send before killing a process.
 *
 * @param server - The server to stop.
 * @param options - Grace periods passed to `stop`.
 * @param signals - The signals to handle. Default `SIGINT` and `SIGTERM`.
 * @returns A function that removes the signal handlers again.
 */
export function stopOnSignals(server: RunningServer, options?: StopOptions, signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"]): () => void {
  /** Stops the server once; later signals wait for the same stop. */
  const onSignal = (): void => {
    void server.stop(options).then(() => process.exit(0), (error: unknown) => {
      process.stderr.write(`holqa: stopping the server failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  };
  for (const signal of signals)
    process.on(signal, onSignal);
  return () => {
    for (const signal of signals)
      process.off(signal, onSignal);
  };
}