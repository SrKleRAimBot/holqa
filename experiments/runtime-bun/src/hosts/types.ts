import type { JsonObject } from "@holqa/experiment-model";

import type {
  HandlerInfo,
  ResourceInfo
} from "@/generation/registry";

/** One structured log line written by a handler. */
export interface LogEntry {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly fields: JsonObject;
  readonly invocationId: string;
  readonly generation: number;
}

/**
 * Runtime-owned resource state that outlives generations: queues and buckets
 * persist across reloads while handlers are replaced. Generation hosts call
 * it to implement the application's {@link RuntimeBinding}.
 */
export interface BindingBackend {
  readonly queueSend: (queueId: string, message: unknown) => Promise<void>;
  readonly bucketPut: (bucketId: string, key: string, body: string | Uint8Array, contentType: string | undefined) => Promise<void>;
  readonly bucketGet: (bucketId: string, key: string) => Promise<Uint8Array | undefined>;
}

/** What a generation needs for one invocation. */
export interface HostInvocation {
  readonly invocationId: string;
  readonly signal: AbortSignal;
  readonly metadata: JsonObject;
}

/** How a generation's module graph is isolated. */
export type ReloadStrategy = "in-process" | "worker";

/**
 * One loaded generation: an evaluated module graph with its registry and
 * binding. The runtime core is independent of how the graph is hosted.
 */
export interface GenerationHost {
  readonly strategy: ReloadStrategy;
  readonly handlers: ReadonlyMap<string, HandlerInfo>;
  readonly resources: ReadonlyMap<string, ResourceInfo>;
  /**
   * Runs a handler in this generation.
   *
   * @param handlerId - A handler in {@link GenerationHost.handlers}.
   * @param input - Untrusted input; the handler validates it.
   * @param invocation - Identifier, cancellation signal and trigger metadata.
   * @returns The handler's result.
   */
  readonly invoke: (handlerId: string, input: unknown, invocation: HostInvocation) => Promise<unknown>;
  /**
   * Releases the generation. In-process hosts unbind the application; worker
   * hosts terminate the worker, which also stops handlers that ignore cancellation.
   *
   * @returns Resolves when the generation is released.
   */
  readonly dispose: () => Promise<void>;
}

/** Options shared by both generation host factories. */
export interface HostOptions {
  readonly root: string;
  readonly entry: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generation: number;
  readonly backend: BindingBackend;
  readonly onLog: (entry: LogEntry) => void;
}