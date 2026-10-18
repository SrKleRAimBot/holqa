import type {
  AppDescriptor,
  ConfigDescriptor,
  Described,
  HandlerDescriptor,
  HttpInvocationInput,
  HttpMethod,
  InvocationContext,
  ResourceDescriptor,
  ResourceId,
  StandardSchemaV1
} from "@holqa/core";

import type { LogEntry } from "@/index";

import {
  createBindingSlot,
  descriptorKey,
  parseResourceId
} from "@holqa/core";

/**
 * Parses an identifier for a fixture, failing loudly on a typo.
 *
 * @param value - The identifier text.
 * @returns The branded identifier.
 * @throws {Error} When the text is not a valid identifier.
 */
export function id(value: string): ResourceId {
  const parsed = parseResourceId(value);
  if (!parsed.ok)
    throw new Error(`Invalid fixture identifier "${value}".`);
  return parsed.value;
}

/**
 * Wraps a descriptor under the protocol key.
 *
 * @param descriptor - Any descriptor.
 * @returns A value carrying it.
 */
export function described<D>(descriptor: D): Described<D> {
  return { [descriptorKey]: descriptor } as Described<D>;
}

/** A Standard Schema that accepts every value. */
export const anySchema: StandardSchemaV1 = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };

/**
 * Builds an HTTP API resource descriptor.
 *
 * @param apiId - The API identifier.
 * @param basePath - Its base path.
 * @returns The resource descriptor.
 */
export function apiResource(apiId: string, basePath = "/api"): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "http.api", id: id(apiId), config: { basePath }, requirements: {}, schemas: {} };
}

/**
 * Builds a queue resource descriptor.
 *
 * @param queueId - The queue identifier.
 * @returns The resource descriptor.
 */
export function queueResource(queueId: string): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "queue", id: id(queueId), config: { schemaVersion: 1 }, requirements: { delivery: "at-least-once", deadLetter: false }, schemas: { message: anySchema } };
}

/**
 * Builds a schedule resource descriptor.
 *
 * @param scheduleId - The schedule identifier.
 * @returns The resource descriptor.
 */
export function scheduleResource(scheduleId: string): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "schedule", id: id(scheduleId), config: { cron: "0 3 * * *", timezone: "UTC" }, requirements: { overlap: "skip" }, schemas: {} };
}

/**
 * A Standard Schema that accepts only non-empty strings.
 */
export const nonEmptyString: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: value => typeof value === "string" && value !== "" ? { value } : { issues: [{ message: "Expected a non-empty string." }] }
  }
};

/**
 * Builds a configuration entry.
 *
 * @param name - The entry's name, also its environment variable.
 * @param schema - The schema its value must satisfy.
 * @param options - Whether it is a secret, and its default.
 * @param options.sensitive - `true` for a secret.
 * @param options.defaultValue - The default of a variable.
 * @returns The configuration descriptor.
 */
export function configEntry(name: string, schema: StandardSchemaV1, options: { readonly sensitive?: boolean; readonly defaultValue?: string } = {}): ConfigDescriptor {
  return { protocol: 1, type: "config", name, sensitive: options.sensitive ?? false, schema, ...options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue } };
}

/**
 * Builds an application with a fresh binding slot.
 *
 * @param resources - Its resources.
 * @param config - Its configuration entries.
 * @param name - Its name.
 * @returns A value carrying the application descriptor.
 */
export function application(resources: readonly ResourceDescriptor[], config: readonly ConfigDescriptor[] = [], name = "shop"): Described<AppDescriptor> {
  return described({ protocol: 1, type: "app", name: id(name), handlers: { include: [], exclude: [] }, resources, config, binding: createBindingSlot() });
}

/** The executable part of an HTTP fixture handler. */
export type HttpFixture = (input: HttpInvocationInput, context: InvocationContext) => Response | Promise<Response>;

/**
 * Builds an HTTP route handler.
 *
 * @param handlerId - The route identifier.
 * @param apiId - The API serving it.
 * @param method - The HTTP method.
 * @param path - The path relative to the API's base path.
 * @param handle - Produces the response.
 * @returns A value carrying the handler descriptor.
 */
export function routeHandler(handlerId: string, apiId: string, method: HttpMethod, path: string, handle: HttpFixture = () => new Response("ok")): Described<HandlerDescriptor> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id(handlerId), trigger: { kind: "http.route", resource: { kind: "http.api", id: id(apiId) }, options: { method, path } } },
    schemas: { responses: {} },
    invoke: async (input: unknown, context: InvocationContext) => handle(input as HttpInvocationInput, context)
  } as HandlerDescriptor);
}

/**
 * Builds an RPC procedure handler.
 *
 * @param handlerId - The procedure identifier.
 * @param apiId - The API serving it.
 * @param operation - `query` or `mutation`.
 * @param handle - Produces the response.
 * @returns A value carrying the handler descriptor.
 */
export function procedureHandler(handlerId: string, apiId: string, operation: "query" | "mutation", handle: HttpFixture = () => Response.json({ format: "holqa.rpc/1", ok: true })): Described<HandlerDescriptor> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id(handlerId), trigger: { kind: "http.procedure", resource: { kind: "http.api", id: id(apiId) }, options: { operation } } },
    schemas: { output: anySchema },
    invoke: async (input: unknown, context: InvocationContext) => handle(input as HttpInvocationInput, context)
  } as HandlerDescriptor);
}

/**
 * Builds a schedule handler, which the runtime can invoke directly.
 *
 * @param handlerId - The handler identifier.
 * @param scheduleId - The schedule it belongs to.
 * @param handle - Runs the handler.
 * @returns A value carrying the handler descriptor.
 */
export function scheduleHandler(handlerId: string, scheduleId: string, handle: (context: InvocationContext<{ readonly scheduledTime: string }>) => unknown): Described<HandlerDescriptor> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id(handlerId), trigger: { kind: "schedule.tick", resource: { kind: "schedule", id: id(scheduleId) }, options: {} } },
    schemas: {},
    invoke: async (_input: unknown, context: InvocationContext<{ readonly scheduledTime: string }>) => handle(context)
  } as HandlerDescriptor);
}

/**
 * Creates a log sink that keeps every entry.
 *
 * @returns The sink and the entries it received.
 */
export function recordingSink(): { readonly sink: (entry: LogEntry) => void; readonly entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { sink: entry => entries.push(entry), entries };
}

/** A promise released by hand, for ordering concurrent work in tests. */
export interface Latch {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

/**
 * Creates a latch.
 *
 * @returns A promise and the function that resolves it.
 */
export function latch(): Latch {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Creates sequential invocation identifiers, so tests can assert on them.
 *
 * @returns A function returning `inv-1`, `inv-2`, ...
 */
export function sequentialIds(): () => string {
  let next = 0;
  return () => `inv-${++next}`;
}