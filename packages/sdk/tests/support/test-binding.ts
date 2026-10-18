import type {
  BindingCapabilities,
  InvocationContext,
  MessageEnvelope,
  ObjectMetadata,
  QueueSendOptions,
  RuntimeBinding
} from "@holqa/core";

/** One recorded queue send: the payload, the full envelope and the send options. */
export interface SentMessage {
  readonly queue: string;
  readonly message: unknown;
  readonly envelope: MessageEnvelope;
  readonly options: QueueSendOptions;
}

/** A recording binding for SDK tests: captures queue sends and keeps objects in memory. */
export interface TestBinding extends RuntimeBinding {
  readonly sent: SentMessage[];
  readonly objects: Map<string, Uint8Array>;
}

/** Capabilities that satisfy every requirement the SDK can declare. */
export const fullCapabilities: BindingCapabilities = {
  "queue": { delivery: ["at-least-once"], maxAttempts: 100, deadLetter: true, backoff: ["fixed", "exponential"], maxDelaySeconds: 900 },
  "bucket": { access: ["private", "public-read"], events: ["object.created", "object.deleted"], signedUrls: { maxExpiresInSeconds: 3600 } },
  "schedule": { overlap: ["skip", "allow"] },
  "http.api": {}
};

/**
 * Creates a binding that records queue sends and stores objects in memory.
 *
 * @param config - Configuration values by entry name.
 * @param capabilities - Advertised capabilities; defaults to {@link fullCapabilities}.
 * @returns The recording binding.
 */
export function createTestBinding(config: Readonly<Record<string, unknown>> = {}, capabilities: BindingCapabilities = fullCapabilities): TestBinding {
  const sent: SentMessage[] = [];
  const objects = new Map<string, Uint8Array>();
  /**
   * Describes a stored object.
   *
   * @param key - The object's key within its bucket.
   * @param body - The stored bytes.
   * @returns Metadata with a size-based etag and a fixed modification time.
   */
  const metadata = (key: string, body: Uint8Array): ObjectMetadata => ({ key, size: body.length, etag: `size-${body.length}`, lastModified: "2026-10-18T00:00:00.000Z" });
  return {
    name: "test",
    sent,
    objects,
    capabilities,
    drivers: {
      queue: resource => ({
        send: async (envelope, options) => {
          sent.push({ queue: resource.id, message: envelope.payload, envelope, options });
          return { messageId: `m-${sent.length}` };
        }
      }),
      bucket: resource => ({
        put: async (key, body) => {
          objects.set(`${resource.id}/${key}`, body);
          return metadata(key, body);
        },
        get: async key => objects.get(`${resource.id}/${key}`),
        head: async (key) => {
          const body = objects.get(`${resource.id}/${key}`);
          return body === undefined ? undefined : metadata(key, body);
        },
        delete: async key => objects.delete(`${resource.id}/${key}`),
        list: async ({ prefix = "", limit = 100 }) => ({
          objects: [...objects].filter(([path]) => path.startsWith(`${resource.id}/${prefix}`)).slice(0, limit).map(([path, body]) => metadata(path.slice(resource.id.length + 1), body))
        }),
        signUrl: async (key, options) => ({ url: `https://signed.test/${resource.id}/${key}`, method: options.method, expiresAt: "2026-10-18T01:00:00.000Z", headers: {} })
      })
    },
    config: entry => config[entry.name] ?? entry.defaultValue
  };
}

/**
 * Creates an invocation context with a fresh abort signal and silent logging.
 *
 * @param metadata - Trigger metadata, such as the delivery attempt.
 * @returns A context whose signal is never aborted and whose logger discards output.
 */
export function createContext<Metadata>(metadata: Metadata): InvocationContext<Metadata> {
  /** Discards a log entry. */
  const silent = (): void => {};
  return { invocationId: "inv-1", signal: new AbortController().signal, metadata, log: { info: silent, warn: silent, error: silent } };
}

/**
 * Runs a function that must throw and returns the codes of the diagnostics it threw.
 *
 * @param run - The function expected to throw a Holqa error.
 * @returns The diagnostic codes, or an empty list when nothing was thrown.
 */
export function thrownCodes(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (typeof error === "object" && error !== null && "diagnostics" in error && Array.isArray(error.diagnostics))
      return (error.diagnostics as Array<{ readonly code: string }>).map(diagnostic => diagnostic.code);
    throw error;
  }
  return [];
}