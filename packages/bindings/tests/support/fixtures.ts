import type {
  AnyBindingProvider,
  AppDescriptor,
  BindingProvider,
  BindingServiceName,
  ConfigDescriptor,
  ProviderContext,
  ProviderInstance,
  QueueSendReceipt,
  ResourceDescriptor,
  ResourceId,
  ResourceKind,
  StandardSchemaV1,
  TelemetryExporter
} from "@holqa/core";

import {
  createBindingSlot,
  descriptorKey,
  parseResourceId
} from "@holqa/core";

/** A schema that accepts any string. */
export const stringSchema: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: value => typeof value === "string" ? { value } : { issues: [{ message: "Expected a string.", path: [] }] }
  }
};

/**
 * Parses an identifier the test knows to be valid.
 *
 * @param value - A valid identifier.
 * @returns The branded identifier.
 */
function id(value: string): ResourceId {
  const parsed = parseResourceId(value);
  if (!parsed.ok)
    throw new Error(parsed.error.message);
  return parsed.value;
}

/** Descriptors of the test application's resources. */
const descriptors: readonly ResourceDescriptor[] = [
  { protocol: 1, type: "resource", kind: "queue", id: id("orders"), config: { schemaVersion: 1 }, requirements: { delivery: "at-least-once", deadLetter: true }, schemas: { message: stringSchema } },
  { protocol: 1, type: "resource", kind: "queue", id: id("audit"), config: { schemaVersion: 1 }, requirements: { delivery: "at-least-once", deadLetter: false }, schemas: { message: stringSchema } },
  { protocol: 1, type: "resource", kind: "bucket", id: id("files"), config: {}, requirements: { access: "private" }, schemas: {} },
  { protocol: 1, type: "resource", kind: "schedule", id: id("nightly"), config: { cron: "0 3 * * *", timezone: "UTC" }, requirements: { overlap: "skip" }, schemas: {} },
  { protocol: 1, type: "resource", kind: "http.api", id: id("api"), config: { basePath: "/" }, schemas: {}, requirements: {} }
];

/** The test application's configuration entries. */
const config: readonly ConfigDescriptor[] = [
  { protocol: 1, type: "config", name: "API_TOKEN", sensitive: true, schema: stringSchema },
  { protocol: 1, type: "config", name: "REGION", sensitive: false, schema: stringSchema, defaultValue: "eu" }
];

/**
 * Builds a handle-like object, the way `@holqa/sdk` handles look structurally.
 *
 * @param kind - The resource kind.
 * @param resourceId - The identifier.
 * @returns A handle with a literal kind and identifier.
 */
function handle<const Kind extends ResourceKind, const Id extends string>(kind: Kind, resourceId: Id): { readonly kind: Kind; readonly id: Id } {
  return { kind, id: resourceId, [descriptorKey]: descriptors.find(descriptor => String(descriptor.id) === resourceId) } as { readonly kind: Kind; readonly id: Id };
}

/** The test application's type: typed handles plus a descriptor. */
export interface TestApp {
  readonly "~holqa": AppDescriptor;
  readonly "resources": {
    readonly orders: { readonly kind: "queue"; readonly id: "orders" };
    readonly audit: { readonly kind: "queue"; readonly id: "audit" };
    readonly files: { readonly kind: "bucket"; readonly id: "files" };
    readonly nightly: { readonly kind: "schedule"; readonly id: "nightly" };
    readonly api: { readonly kind: "http.api"; readonly id: "api" };
  };
}

/**
 * Creates a fresh test application with typed handles and a descriptor, as
 * `defineApp` would.
 *
 * @returns The application.
 */
export function createApp(): TestApp {
  const descriptor: AppDescriptor = { protocol: 1, type: "app", name: id("shop"), handlers: { include: [], exclude: [] }, resources: descriptors, config, binding: createBindingSlot() };
  return {
    [descriptorKey]: descriptor,
    resources: {
      orders: handle("queue", "orders"),
      audit: handle("queue", "audit"),
      files: handle("bucket", "files"),
      nightly: handle("schedule", "nightly"),
      api: handle("http.api", "api")
    }
  } as const;
}

/** What test providers record, in order. */
export type ProviderEvent = `${"open" | "ready" | "stop"}:${string}`;

/** Settings of the test provider factories. */
export interface TestProviderOptions {
  readonly name?: string;
  /** Shared log of lifecycle events. */
  readonly events?: ProviderEvent[];
  /** Makes `open` fail with this error. */
  readonly fail?: unknown;
  /** Called with the context when the provider is opened. */
  readonly onOpen?: (context: ProviderContext) => void;
}

/**
 * Builds a provider instance that records its lifecycle.
 *
 * @param name - The provider's name.
 * @param options - Where to record events.
 * @param parts - The drivers, sources and services of the instance.
 * @returns The instance with recording lifecycle hooks.
 */
function recordingInstance(name: string, options: TestProviderOptions, parts: ProviderInstance): ProviderInstance {
  return {
    ...parts,
    ready: async () => {
      options.events?.push(`ready:${name}`);
    },
    health: async () => ({ status: "healthy" }),
    stop: async () => {
      options.events?.push(`stop:${name}`);
    }
  };
}

/**
 * Opens a test provider: records the event and fails when asked to.
 *
 * @param name - The provider's name.
 * @param options - The test settings.
 * @param context - The provider context.
 */
function opening(name: string, options: TestProviderOptions, context: ProviderContext): void {
  options.events?.push(`open:${name}`);
  options.onOpen?.(context);
  if (options.fail !== undefined)
    throw options.fail;
}

/** Messages sent through test queue providers, by provider name. */
export const sentMessages = new Map<string, Array<{ readonly queue: string; readonly payload: unknown }>>();

/**
 * Creates a queue-only resource provider whose driver records sent payloads.
 *
 * @param options - Name, event log and failure.
 * @returns A resource provider that binds queues only.
 */
export function testQueueProvider(options: TestProviderOptions = {}): BindingProvider<"queue"> {
  const name = options.name ?? "broker";
  return {
    bindingProtocol: 1,
    provider: "example.broker",
    name,
    role: "resource",
    contracts: { queue: 1 },
    resources: { queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: false, backoff: ["fixed"], maxDelaySeconds: 60 } },
    services: {},
    topology: { delivery: "pull", state: "shared" },
    settings: { cluster: "primary" },
    open: async (context) => {
      opening(name, options, context);
      return recordingInstance(name, options, {
        drivers: {
          queue: resource => ({
            send: async (envelope): Promise<QueueSendReceipt> => {
              const sent = sentMessages.get(name) ?? [];
              sent.push({ queue: resource.id, payload: envelope.payload });
              sentMessages.set(name, sent);
              return { messageId: `${name}-${sent.length}` };
            }
          })
        }
      });
    }
  };
}

/**
 * Creates a complete platform provider whose drivers record payloads and
 * whose configuration comes from a fixed record.
 *
 * @param options - Name, event log, failure, and configuration values.
 * @param values - Configuration values the platform's configuration service returns.
 * @returns The provider.
 */
export function testPlatform(options: TestProviderOptions = {}, values: Readonly<Record<string, string>> = {}): BindingProvider<"queue" | "bucket" | "schedule" | "http.api" | "static.site", "config" | "telemetry" | "idempotency"> {
  const name = options.name ?? "platform";
  return {
    bindingProtocol: 1,
    provider: "example.platform",
    name,
    role: "platform",
    contracts: { "execution": 1, "http.api": 1, "queue": 1, "bucket": 1, "bucket.events": 1, "schedule": 1, "static.site": 1, "config": 1, "telemetry": 1, "idempotency": 1 },
    resources: {
      "queue": { delivery: ["at-least-once"], maxAttempts: 100, deadLetter: true, backoff: ["fixed", "exponential"], maxDelaySeconds: 900 },
      "bucket": { access: ["private", "public-read"], events: ["object.created", "object.deleted"] },
      "schedule": { overlap: ["skip", "allow"] },
      "http.api": {},
      "static.site": { spaFallback: true }
    },
    services: { config: true, telemetry: true, idempotency: true },
    execution: { runtimes: ["bun"], mode: "long-running" },
    topology: { delivery: "pull", state: "host" },
    open: async (context) => {
      opening(name, options, context);
      const exporter: TelemetryExporter = { name: `${name}-exporter`, exportSpans: async () => {} };
      return recordingInstance(name, options, {
        drivers: {
          queue: resource => ({
            send: async (envelope): Promise<QueueSendReceipt> => {
              const sent = sentMessages.get(name) ?? [];
              sent.push({ queue: resource.id, payload: envelope.payload });
              sentMessages.set(name, sent);
              return { messageId: `${name}-${sent.length}` };
            }
          }),
          bucket: () => ({
            put: async key => ({ key, size: 0, etag: "e", lastModified: "2026-01-01T00:00:00.000Z" }),
            get: async () => undefined,
            head: async () => undefined,
            delete: async () => false,
            list: async () => ({ objects: [] }),
            signUrl: async () => ({ url: "http://localhost/", method: "GET", expiresAt: "2026-01-01T00:00:00.000Z", headers: {} })
          })
        },
        sources: {
          queue: () => ({ receive: async () => [], acknowledge: async () => true, retry: async () => true, deadLetter: async () => true, discard: async () => true, wait: async () => {}, defaultMaxAttempts: 5 }),
          bucket: () => ({ subscribe: async () => ({ receive: async () => [], acknowledge: async () => true, retry: async () => true, deadLetter: async () => true, discard: async () => true, wait: async () => {} }) }),
          schedule: () => ({ start: async () => ({ stop: async () => {} }) })
        },
        config: { lookup: key => values[key] },
        telemetry: [exporter],
        idempotency: {
          begin: async () => ({ status: "acquired", token: "t" }),
          complete: async () => true,
          release: async () => true,
          extend: async () => true
        }
      });
    }
  };
}

/**
 * Creates a service provider for one service.
 *
 * @param service - The service it supplies.
 * @param options - Name, event log and failure.
 * @param instance - What it opens to.
 * @returns A service provider that opens to `instance`.
 */
export function testService<Service extends BindingServiceName>(service: Service, options: TestProviderOptions, instance: ProviderInstance): BindingProvider<never, Service> {
  const name = options.name ?? service;
  return {
    bindingProtocol: 1,
    provider: "example.service",
    name,
    role: "service",
    contracts: { [service]: 1 },
    resources: {},
    services: { [service]: true },
    open: async (context) => {
      opening(name, options, context);
      return recordingInstance(name, options, instance);
    }
  } as BindingProvider<never, Service>;
}

/**
 * Returns the provider names of a list, for compact assertions.
 *
 * @param providers - The providers to summarize.
 * @returns Their names.
 */
export function names(providers: readonly AnyBindingProvider[]): string[] {
  return providers.map(provider => provider.name);
}