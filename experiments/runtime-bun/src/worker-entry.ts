// Entry point of a generation worker (strategy B). Each worker evaluates its
// own module graph, so every generation has fresh module state. The runtime in
// the host thread owns queues and buckets; the worker forwards resource
// operations to it.
import type { PreparedGeneration } from "@/generation/prepare";
import type { BindingBackend } from "@/hosts/types";
import type {
  BindingRequest,
  HostToWorker,
  WorkerToHost
} from "@/hosts/worker-protocol";

import { experimentCodes } from "@holqa/experiment-model";

import { holqaError } from "@/diagnostics";
import { prepareGeneration } from "@/generation/prepare";
import {
  deserializeError,
  serializeError
} from "@/hosts/worker-protocol";

/** The parts of a worker's global scope this entry point uses. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<HostToWorker>) => void) | null;
  postMessage: (message: WorkerToHost) => void;
}

const scope = globalThis as unknown as WorkerScope;
const controllers = new Map<number, AbortController>();
const bindingRequests = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>();
let nextRequest = 0;
let invokeHandler: PreparedGeneration["invoke"] | undefined;

/**
 * Asks the host to perform a resource operation and waits for its answer.
 *
 * @param request - The operation.
 * @returns The operation's result value.
 */
async function requestBinding(request: BindingRequest): Promise<unknown> {
  const requestId = nextRequest++;
  return new Promise((resolve, reject) => {
    bindingRequests.set(requestId, { resolve, reject });
    scope.postMessage({ type: "binding", requestId, request });
  });
}

const backend: BindingBackend = {
  queueSend: async (queueId, message) => {
    await requestBinding({ op: "queue.send", queueId, message });
  },
  bucketPut: async (bucketId, key, body, contentType) => {
    await requestBinding({ op: "bucket.put", bucketId, key, body, contentType });
  },
  bucketGet: async (bucketId, key) => await requestBinding({ op: "bucket.get", bucketId, key }) as Uint8Array | undefined
};

/**
 * Loads the generation's module graph and reports its registry or diagnostics.
 *
 * @param message - The load request.
 */
async function load(message: HostToWorker & { readonly type: "load" }): Promise<void> {
  const prepared = await prepareGeneration({ ...message, backend, onLog: entry => scope.postMessage({ type: "log", entry }) });
  if (!prepared.ok) {
    scope.postMessage({ type: "loaded", ok: false, diagnostics: prepared.error });
    return;
  }
  invokeHandler = prepared.value.invoke;
  scope.postMessage({
    type: "loaded",
    ok: true,
    handlers: [...prepared.value.registry.handlers.values()].map(handler => handler.info),
    resources: [...prepared.value.registry.resources.values()]
  });
}

/**
 * Runs one invocation and posts its result.
 *
 * @param message - The invocation request.
 */
async function invoke(message: HostToWorker & { readonly type: "invoke" }): Promise<void> {
  const controller = new AbortController();
  controllers.set(message.callId, controller);
  try {
    if (invokeHandler === undefined)
      throw holqaError(experimentCodes.handlerNotFound, "The generation worker has not loaded an application.");
    const value = await invokeHandler(message.handlerId, message.input, { invocationId: message.invocationId, signal: controller.signal, metadata: message.metadata });
    try {
      scope.postMessage({ type: "result", callId: message.callId, ok: true, value });
    } catch (error) {
      scope.postMessage({ type: "result", callId: message.callId, ok: false, error: serializeError(error) });
    }
  } catch (error) {
    scope.postMessage({ type: "result", callId: message.callId, ok: false, error: serializeError(error) });
  } finally {
    controllers.delete(message.callId);
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case "load":
      void load(message);
      break;
    case "invoke":
      void invoke(message);
      break;
    case "abort":
      controllers.get(message.callId)?.abort(holqaError(experimentCodes.invocationCancelled, message.reason));
      break;
    case "binding-result": {
      const pending = bindingRequests.get(message.requestId);
      bindingRequests.delete(message.requestId);
      if (message.ok)
        pending?.resolve(message.value);
      else
        pending?.reject(deserializeError(message.error));
      break;
    }
  }
};