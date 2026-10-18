import type {
  BindingCapabilities,
  InvocationContext,
  RuntimeBinding
} from "@holqa/core";

/** A recording binding for SDK tests: captures queue sends and keeps objects in memory. */
export interface TestBinding extends RuntimeBinding {
  readonly sent: Array<{ readonly queue: string; readonly message: unknown }>;
  readonly objects: Map<string, Uint8Array>;
}

/** Capabilities that satisfy every requirement the SDK can declare. */
export const fullCapabilities: BindingCapabilities = {
  "queue": { delivery: ["at-least-once"], maxAttempts: 100, deadLetter: true },
  "bucket": { access: ["private", "public-read"] },
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
  const sent: Array<{ readonly queue: string; readonly message: unknown }> = [];
  const objects = new Map<string, Uint8Array>();
  return {
    name: "test",
    sent,
    objects,
    capabilities,
    drivers: {
      queue: resource => ({
        send: async (message) => {
          sent.push({ queue: resource.id, message });
        }
      }),
      bucket: resource => ({
        put: async (key, body) => {
          objects.set(`${resource.id}/${key}`, typeof body === "string" ? new TextEncoder().encode(body) : body);
        },
        get: async key => objects.get(`${resource.id}/${key}`)
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