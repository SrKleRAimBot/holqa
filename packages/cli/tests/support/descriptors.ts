import type {
  AppDescriptor,
  ConfigDescriptor,
  Described,
  HandlerDescriptor,
  ResourceDescriptor,
  ResourceId,
  StandardSchemaV1
} from "@holqa/core";

import {
  createBindingSlot,
  parseResourceId
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
 * @returns The queue descriptor.
 */
export function queue(queueId: string): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "queue", id: id(queueId), config: { schemaVersion: 1 }, requirements: { delivery: "at-least-once", deadLetter: false }, schemas: { message: text } };
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