import type {
  AppDescriptor,
  ConfigDescriptor,
  Described,
  HandlerDescriptor,
  HttpMethod,
  InvocationContext,
  ResourceDescriptor,
  ResourceId,
  StandardSchemaV1

} from "@holqa/core";

import {
  createBindingSlot,
  getAppDescriptor,
  parseResourceId,
  resolveDriver
} from "@holqa/core";

// Descriptors written as plain objects, the way any SDK would write them.
// The CLI may depend only on @holqa/core and @holqa/compiler, so its fixture
// applications never use @holqa/sdk.

/**
 * Parses an identifier that a fixture knows to be valid.
 *
 * @param value - A valid identifier.
 * @returns The branded identifier.
 * @throws {Error} When the identifier is invalid, which indicates a broken fixture.
 */
function id(value: string): ResourceId {
  const parsed = parseResourceId(value);
  if (!parsed.ok)
    throw new Error(parsed.error.message);
  return parsed.value;
}

/**
 * A string schema of vendor `fixture` that describes itself with Standard JSON
 * Schema; without an adapter package the compiler records it as unverified.
 */
export const text: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "fixture",
    validate: value => typeof value === "string" ? { value } : { issues: [{ message: "Expected a string." }] },
    jsonSchema: { input: () => ({ type: "string" }), output: () => ({ type: "string" }) }
  } as StandardSchemaV1<string>["~standard"]
};

/**
 * Declares a queue.
 *
 * @param queueId - The queue identifier.
 * @param message - The message schema.
 * @returns The queue descriptor.
 */
export function queue(queueId: string, message: StandardSchemaV1 = text): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "queue", id: id(queueId), config: { schemaVersion: 1 }, requirements: { delivery: "at-least-once", deadLetter: false }, schemas: { message } };
}

/**
 * Declares a secret configuration entry.
 *
 * @param name - The entry name, which is also its environment variable name.
 * @returns The configuration descriptor.
 */
export function secret(name: string): ConfigDescriptor {
  return { protocol: 1, type: "config", name, sensitive: true, schema: text };
}

/**
 * Builds an application value as `defineApp` would return it.
 *
 * @param name - The application name, in identifier grammar.
 * @param resources - The declared resources.
 * @param config - The configuration entries.
 * @returns A value carrying an application descriptor.
 */
export function application(name: string, resources: readonly ResourceDescriptor[], config: readonly ConfigDescriptor[] = []): Described<AppDescriptor> {
  return { "~holqa": { protocol: 1, type: "app", name: id(name), handlers: { include: ["src/*.handler.ts"], exclude: [] }, resources, config, binding: createBindingSlot() } };
}

/**
 * Registers a queue consumer.
 *
 * @param handlerId - The handler identifier.
 * @param queueId - The consumed queue.
 * @returns A value carrying a handler descriptor.
 */
export function consumer(handlerId: string, queueId: string): Described<HandlerDescriptor> {
  return {
    "~holqa": {
      protocol: 1,
      type: "handler",
      definition: { id: id(handlerId), trigger: { kind: "queue.message", resource: { kind: "queue", id: id(queueId) }, options: {} } },
      schemas: { message: text },
      invoke: async () => undefined
    }
  };
}

/**
 * A schema of vendor `fixture` that describes itself as the given JSON
 * Schema type, so a test can change a contract. For `string` and `number` it
 * also rejects values of other types; any other type accepts every value.
 *
 * @param type - The JSON Schema type it reports.
 * @returns The schema.
 */
export function described(type: string): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate: value => (type === "string" && typeof value !== "string") || (type === "number" && typeof value !== "number") ? { issues: [{ message: `Expected a ${type}.` }] } : { value },
      jsonSchema: { input: () => ({ type }), output: () => ({ type }) }
    } as StandardSchemaV1["~standard"]
  };
}

/**
 * Declares an HTTP API.
 *
 * @param apiId - The API identifier.
 * @param basePath - Its base path.
 * @returns The API descriptor.
 */
export function api(apiId: string, basePath = "/api"): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "http.api", id: id(apiId), config: { basePath }, requirements: {}, schemas: {} };
}

/**
 * Declares a schedule.
 *
 * @param scheduleId - The schedule identifier.
 * @param cron - Its cron expression.
 * @returns The schedule descriptor.
 */
export function schedule(scheduleId: string, cron = "0 * * * *"): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "schedule", id: id(scheduleId), config: { cron, timezone: "UTC" }, requirements: { overlap: "skip" }, schemas: {} };
}

/**
 * Registers an HTTP route whose handler builds the response itself.
 *
 * @param handlerId - The handler identifier.
 * @param apiId - The serving API.
 * @param method - The HTTP method it serves.
 * @param path - The path relative to the API's base path.
 * @param respond - Builds the response.
 * @returns A value carrying a handler descriptor.
 */
export function route(handlerId: string, apiId: string, method: HttpMethod, path: string, respond: () => Response | Promise<Response>): Described<HandlerDescriptor> {
  return {
    "~holqa": {
      protocol: 1,
      type: "handler",
      definition: { id: id(handlerId), trigger: { kind: "http.route", resource: { kind: "http.api", id: id(apiId) }, options: { method, path } } },
      schemas: { responses: {} },
      invoke: async () => respond()
    } as HandlerDescriptor
  };
}

/**
 * Registers a queue consumer that runs a function for every message.
 *
 * @param handlerId - The handler identifier.
 * @param queueId - The consumed queue.
 * @param handle - Runs for every message; throwing fails the attempt.
 * @param message - The message schema; it must be the queue's.
 * @returns A value carrying a handler descriptor.
 */
export function worker(handlerId: string, queueId: string, handle: (message: unknown, context: InvocationContext<{ readonly attempt: number }>) => unknown, message: StandardSchemaV1 = text): Described<HandlerDescriptor> {
  return {
    "~holqa": {
      protocol: 1,
      type: "handler",
      definition: { id: id(handlerId), trigger: { kind: "queue.message", resource: { kind: "queue", id: id(queueId) }, options: {} } },
      schemas: { message },
      invoke: async (input: unknown, context: InvocationContext<{ readonly attempt: number }>) => handle(input, context)
    } as HandlerDescriptor
  };
}

/**
 * Registers a schedule handler.
 *
 * @param handlerId - The handler identifier.
 * @param scheduleId - The schedule whose runs it handles.
 * @param handle - Runs for every run.
 * @returns A value carrying a handler descriptor.
 */
export function tick(handlerId: string, scheduleId: string, handle: () => unknown): Described<HandlerDescriptor> {
  return {
    "~holqa": {
      protocol: 1,
      type: "handler",
      definition: { id: id(handlerId), trigger: { kind: "schedule.tick", resource: { kind: "schedule", id: id(scheduleId) }, options: {} } },
      schemas: {},
      invoke: async () => handle()
    } as HandlerDescriptor
  };
}

/**
 * Sends a text message to a queue of an application, as the SDK's `send` would.
 *
 * @param app - The application value.
 * @param queueId - The queue to send to.
 * @param message - The text.
 * @returns The message identifier.
 */
export async function send(app: unknown, queueId: string, message: string): Promise<string> {
  const descriptor = getAppDescriptor(app)!;
  const resource = descriptor.resources.find(candidate => candidate.id === queueId)! as ResourceDescriptor & { readonly kind: "queue" };
  return (await resolveDriver(descriptor, resource, "send").send({ format: "holqa.message/1", schemaVersion: 1, payload: message }, {})).messageId;
}