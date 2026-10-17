import type { JsonObject } from "@holqa/experiment-model";

import type { RuntimeDiagnostic } from "@/diagnostics";
import type {
  HandlerInfo,
  ResourceInfo
} from "@/generation/registry";
import type { LogEntry } from "@/hosts/types";

import { HolqaError } from "@holqa/experiment-model";

/** An error reduced to structured-clone-safe data. */
export interface SerializedError {
  readonly message: string;
  readonly diagnostic?: RuntimeDiagnostic;
}

/** A resource operation the worker asks the host to perform on runtime-owned state. */
export type BindingRequest
  = | { readonly op: "queue.send"; readonly queueId: string; readonly message: unknown }
    | { readonly op: "bucket.put"; readonly bucketId: string; readonly key: string; readonly body: string | Uint8Array; readonly contentType: string | undefined }
    | { readonly op: "bucket.get"; readonly bucketId: string; readonly key: string };

/** Messages from the runtime (host thread) to a generation worker. */
export type HostToWorker
  = | { readonly type: "load"; readonly root: string; readonly entry: string; readonly env: Readonly<Record<string, string | undefined>>; readonly generation: number }
    | { readonly type: "invoke"; readonly callId: number; readonly handlerId: string; readonly input: unknown; readonly invocationId: string; readonly metadata: JsonObject }
    | { readonly type: "abort"; readonly callId: number; readonly reason: string }
    | { readonly type: "binding-result"; readonly requestId: number; readonly ok: true; readonly value: unknown }
    | { readonly type: "binding-result"; readonly requestId: number; readonly ok: false; readonly error: SerializedError };

/** Messages from a generation worker to the runtime. */
export type WorkerToHost
  = | { readonly type: "loaded"; readonly ok: true; readonly handlers: readonly HandlerInfo[]; readonly resources: readonly ResourceInfo[] }
    | { readonly type: "loaded"; readonly ok: false; readonly diagnostics: readonly RuntimeDiagnostic[] }
    | { readonly type: "result"; readonly callId: number; readonly ok: true; readonly value: unknown }
    | { readonly type: "result"; readonly callId: number; readonly ok: false; readonly error: SerializedError }
    | { readonly type: "log"; readonly entry: LogEntry }
    | { readonly type: "binding"; readonly requestId: number; readonly request: BindingRequest };

/**
 * Reduces a thrown value to data that survives `postMessage`, keeping a Holqa
 * diagnostic when there is one.
 *
 * @param error - Any thrown value.
 * @returns The serialized error.
 */
export function serializeError(error: unknown): SerializedError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HolqaError)
    return { message, diagnostic: { ...error.diagnostic } };
  return { message };
}

/**
 * Rebuilds an error on the receiving side of a worker boundary.
 *
 * @param error - The serialized error.
 * @returns A `HolqaError` when a diagnostic was carried, otherwise a plain `Error`.
 */
export function deserializeError(error: SerializedError): Error {
  return error.diagnostic !== undefined && error.diagnostic.code.startsWith("HOLQA_")
    ? new HolqaError(error.diagnostic as HolqaError["diagnostic"])
    : new Error(error.message);
}