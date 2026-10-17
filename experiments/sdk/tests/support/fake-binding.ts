import type {
  InvocationContext,
  RuntimeBinding
} from "@holqa/experiment-model";

/** A recording binding for SDK tests: captures sent messages and stored objects. */
export interface FakeBinding extends RuntimeBinding {
  readonly sent: Array<{ readonly queue: string; readonly message: unknown }>;
  readonly objects: Map<string, Uint8Array>;
}

/**
 * Creates a binding that records queue sends and stores objects in memory.
 *
 * @param config - Already-validated configuration values by name.
 * @returns The recording binding.
 */
export function createFakeBinding(config: Readonly<Record<string, unknown>> = {}): FakeBinding {
  const sent: Array<{ readonly queue: string; readonly message: unknown }> = [];
  const objects = new Map<string, Uint8Array>();
  return {
    sent,
    objects,
    queue: queue => ({ send: async (message) => {
      sent.push({ queue, message });
    } }),
    bucket: bucket => ({
      put: async (key, body) => {
        objects.set(`${bucket}/${key}`, typeof body === "string" ? new TextEncoder().encode(body) : body);
      },
      get: async key => objects.get(`${bucket}/${key}`)
    }),
    config: name => config[name]
  };
}

/**
 * Creates an invocation context with a fresh abort signal and silent logging.
 *
 * @param metadata - Trigger metadata, such as the delivery attempt.
 * @returns A context whose signal is never aborted and whose logger discards output.
 */
export function createContext(metadata: InvocationContext["metadata"] = {}): InvocationContext {
  /** Discards a log entry. */
  const silent = (): void => {};
  return { invocationId: "inv-1", signal: new AbortController().signal, metadata, log: { info: silent, warn: silent, error: silent } };
}