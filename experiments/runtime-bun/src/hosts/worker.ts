import type { Result } from "@holqa/core";

import type { RuntimeDiagnostic } from "@/diagnostics";
import type {
  GenerationHost,
  HostOptions
} from "@/hosts/types";
import type {
  BindingRequest,
  HostToWorker,
  WorkerToHost
} from "@/hosts/worker-protocol";

import {
  err,
  ok
} from "@holqa/core";
import { experimentCodes } from "@holqa/experiment-model";

import {
  describeError,
  holqaError,
  runtimeError
} from "@/diagnostics";
import {
  deserializeError,
  serializeError
} from "@/hosts/worker-protocol";

/**
 * Locates the worker entry point next to this module. Running from source the
 * file is `src/worker-entry.ts`; in the build it is `dist/worker-entry.js`,
 * emitted as a second tsdown entry next to the bundled `index.js`.
 *
 * @returns The worker script URL.
 */
function workerEntryUrl(): string {
  return new URL(import.meta.url.endsWith(".ts") ? "../worker-entry.ts" : "./worker-entry.js", import.meta.url).href;
}

/**
 * Performs a worker's resource request against the runtime-owned backend.
 *
 * @param options - The host options holding the backend.
 * @param request - The requested operation.
 * @returns The operation's result.
 */
async function performBinding(options: HostOptions, request: BindingRequest): Promise<unknown> {
  switch (request.op) {
    case "queue.send":
      return options.backend.queueSend(request.queueId, request.message);
    case "bucket.put":
      return options.backend.bucketPut(request.bucketId, request.key, request.body, request.contentType);
    case "bucket.get":
      return options.backend.bucketGet(request.bucketId, request.key);
  }
}

/**
 * Loads a generation into its own Bun Worker (strategy B). The worker has a
 * fresh module graph, so module state is isolated without relying on module
 * cache eviction, and `dispose` terminates the worker, which stops even
 * handlers that ignore their abort signal. Invocation inputs and results cross
 * the boundary by structured clone.
 *
 * @param options - Application location, configuration, backend and log sink.
 * @returns The host, or the diagnostics that prevented loading.
 */
export async function createWorkerHost(options: HostOptions): Promise<Result<GenerationHost, RuntimeDiagnostic[]>> {
  const worker = new Worker(workerEntryUrl());
  const calls = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>();
  let nextCall = 0;
  let terminated = false;
  const { promise: loaded, resolve: resolveLoaded, reject: rejectLoaded } = Promise.withResolvers<WorkerToHost & { readonly type: "loaded" }>();

  /**
   * Sends a message to the worker unless it has been terminated.
   *
   * @param message - A load, invoke, abort or binding-result message.
   */
  const post = (message: HostToWorker): void => {
    if (!terminated)
      worker.postMessage(message);
  };

  /**
   * Terminates the worker and rejects every pending invocation.
   *
   * @param reason - Why the worker stops, used in the rejection.
   */
  const terminate = (reason: string): void => {
    if (terminated)
      return;
    terminated = true;
    worker.terminate();
    for (const call of calls.values())
      call.reject(holqaError(experimentCodes.invocationCancelled, reason));
    calls.clear();
  };

  worker.onmessage = (event: MessageEvent<WorkerToHost>) => {
    const message = event.data;
    switch (message.type) {
      case "loaded":
        resolveLoaded(message);
        break;
      case "result": {
        const call = calls.get(message.callId);
        calls.delete(message.callId);
        if (message.ok)
          call?.resolve(message.value);
        else
          call?.reject(deserializeError(message.error));
        break;
      }
      case "log":
        options.onLog(message.entry);
        break;
      case "binding":
        performBinding(options, message.request).then(
          value => post({ type: "binding-result", requestId: message.requestId, ok: true, value }),
          (error: unknown) => post({ type: "binding-result", requestId: message.requestId, ok: false, error: serializeError(error) })
        );
        break;
    }
  };
  worker.onerror = (event) => {
    rejectLoaded(new Error(event.message));
    terminate(`Generation worker crashed: ${event.message}`);
  };

  post({ type: "load", root: options.root, entry: options.entry, env: options.env, generation: options.generation });
  let result: WorkerToHost & { readonly type: "loaded" };
  try {
    result = await loaded;
  } catch (error) {
    terminate("Generation worker failed to load.");
    return err([runtimeError(experimentCodes.moduleEvaluationFailed, `The generation worker failed: ${describeError(error)}`)]);
  }
  if (!result.ok) {
    terminate("Generation failed to load.");
    return err([...result.diagnostics]);
  }

  return ok({
    strategy: "worker",
    handlers: new Map(result.handlers.map(handler => [handler.id, handler])),
    resources: new Map(result.resources.map(resource => [resource.id, resource])),
    invoke: async (handlerId, input, invocation) => {
      if (terminated)
        throw holqaError(experimentCodes.invocationCancelled, "The generation worker was terminated.");
      const callId = nextCall++;
      return new Promise((resolve, reject) => {
        /** Forwards the invocation's cancellation to the worker. */
        const onAbort = (): void => {
          post({ type: "abort", callId, reason: describeError(invocation.signal.reason) });
        };
        invocation.signal.addEventListener("abort", onAbort, { once: true });
        calls.set(callId, {
          resolve: (value) => {
            invocation.signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (error) => {
            invocation.signal.removeEventListener("abort", onAbort);
            reject(error);
          }
        });
        post({ type: "invoke", callId, handlerId, input, invocationId: invocation.invocationId, metadata: invocation.metadata });
      });
    },
    dispose: async () => terminate("The generation was disposed.")
  });
}