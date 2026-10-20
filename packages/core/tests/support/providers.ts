import type {
  AnyBindingProvider,
  BindingProvider,
  ProviderInstance
} from "@/index";

/**
 * Builds a queue-only resource provider that opens to an empty instance.
 *
 * @param overrides - Fields to replace, for negative tests.
 * @returns A provider that binds queues.
 */
export function queueProvider(overrides: Partial<Record<keyof AnyBindingProvider, unknown>> = {}): BindingProvider<"queue"> {
  return {
    bindingProtocol: 1,
    provider: "example.queue",
    name: "example-queue",
    role: "resource",
    contracts: { queue: 1 },
    resources: { queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, backoff: ["fixed"], maxDelaySeconds: 60 } },
    services: {},
    topology: { delivery: "pull", state: "shared" },
    open: async (): Promise<ProviderInstance> => ({}),
    ...overrides
  } as BindingProvider<"queue">;
}

/**
 * Builds a complete platform provider that opens to an empty instance.
 *
 * @param overrides - Fields to replace, for negative tests.
 * @returns A provider that implements every mandatory contract.
 */
export function platformProvider(overrides: Partial<Record<keyof AnyBindingProvider, unknown>> = {}): BindingProvider<"queue" | "bucket" | "schedule" | "http.api" | "static.site", "config" | "telemetry"> {
  return {
    bindingProtocol: 1,
    provider: "example.platform",
    name: "platform",
    role: "platform",
    contracts: { "execution": 1, "http.api": 1, "queue": 1, "bucket": 1, "bucket.events": 1, "schedule": 1, "static.site": 1, "config": 1, "telemetry": 1 },
    resources: {
      "queue": { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true },
      "bucket": { access: ["private"], events: ["object.created"] },
      "schedule": { overlap: ["skip"] },
      "http.api": {},
      "static.site": { spaFallback: true }
    },
    services: { config: true, telemetry: true },
    execution: { runtimes: ["bun"], mode: "long-running" },
    open: async (): Promise<ProviderInstance> => ({}),
    ...overrides
  } as BindingProvider<"queue" | "bucket" | "schedule" | "http.api" | "static.site", "config" | "telemetry">;
}