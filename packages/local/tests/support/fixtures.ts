import type {
  AppDescriptor,
  Described,
  HandlerDescriptor,
  InvocationContext,
  QueueRequirements,
  ResourceDescriptor,
  ResourceId,
  StandardSchemaV1
} from "@holqa/core";

import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBindingSlot,
  descriptorKey,
  parseResourceId
} from "@holqa/core";

/**
 * Parses an identifier a test knows to be valid.
 *
 * @param value - A valid identifier.
 * @returns The branded identifier.
 * @throws {Error} When the identifier is invalid, which indicates a broken test.
 */
export function id(value: string): ResourceId {
  const parsed = parseResourceId(value);
  if (!parsed.ok)
    throw new Error(parsed.error.message);
  return parsed.value;
}

/**
 * Wraps a descriptor the way SDK values carry it.
 *
 * @param descriptor - Any descriptor object.
 * @returns An object holding it under the descriptor key.
 */
export function described<D>(descriptor: D): Described<D> {
  return Object.freeze({ [descriptorKey]: descriptor }) as Described<D>;
}

/** A schema that accepts any JSON object with a string `name`. */
export const namedSchema: StandardSchemaV1<{ readonly name: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: value => typeof value === "object" && value !== null && typeof (value as { readonly name?: unknown }).name === "string"
      ? { value: value as { readonly name: string } }
      : { issues: [{ message: "Expected { name: string }." }] }
  }
};

/** A schema that accepts any value, for object event fixtures. */
export const anySchema: StandardSchemaV1 = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };

/**
 * Builds a queue descriptor whose messages are `{ name: string }`.
 *
 * @param queueId - The queue identifier.
 * @param requirements - Overrides of the delivery requirements.
 * @returns The resource descriptor.
 */
export function queueResource(queueId: string, requirements: Partial<QueueRequirements> = {}): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "queue", id: id(queueId), config: { schemaVersion: 1 }, requirements: { delivery: "at-least-once", deadLetter: true, ...requirements }, schemas: { message: namedSchema } };
}

/**
 * Builds a bucket descriptor.
 *
 * @param bucketId - The bucket identifier.
 * @param access - Its access policy.
 * @returns The resource descriptor.
 */
export function bucketResource(bucketId: string, access: "private" | "public-read" = "private"): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "bucket", id: id(bucketId), config: {}, requirements: { access }, schemas: {} };
}

/**
 * Builds a schedule descriptor.
 *
 * @param scheduleId - The schedule identifier.
 * @param cron - Its cron expression.
 * @param overlap - Its overlap policy.
 * @param timezone - Its time zone.
 * @returns The resource descriptor.
 */
export function scheduleResource(scheduleId: string, cron: string, overlap: "skip" | "allow" = "skip", timezone = "UTC"): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "schedule", id: id(scheduleId), config: { cron, timezone }, requirements: { overlap }, schemas: {} };
}

/**
 * Builds an application with a fresh binding slot.
 *
 * @param resources - Its resources.
 * @returns A value carrying the application descriptor.
 */
export function application(resources: readonly ResourceDescriptor[]): Described<AppDescriptor> {
  return described({ protocol: 1, type: "app", name: id("local-test"), handlers: { include: [], exclude: [] }, resources, config: [], binding: createBindingSlot() });
}

/**
 * Builds a queue consumer.
 *
 * @param handlerId - The handler identifier.
 * @param queueId - The consumed queue.
 * @param handle - Runs for every message.
 * @param concurrency - How many messages may run at once; absent means the runtime default.
 * @returns A value carrying the handler descriptor.
 */
export function consumer(handlerId: string, queueId: string, handle: (message: unknown, context: InvocationContext<{ readonly attempt: number; readonly messageId: string }>) => unknown, concurrency?: number): Described<HandlerDescriptor> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id(handlerId), trigger: { kind: "queue.message", resource: { kind: "queue", id: id(queueId) }, options: concurrency === undefined ? {} : { concurrency } } },
    schemas: { message: namedSchema },
    invoke: async (input: unknown, context: InvocationContext<{ readonly attempt: number; readonly messageId: string }>) => handle(input, context)
  } as HandlerDescriptor);
}

/**
 * Builds an object event handler.
 *
 * @param handlerId - The handler identifier.
 * @param bucketId - The watched bucket.
 * @param kind - Which events it handles.
 * @param handle - Runs for every event.
 * @param prefix - Its key prefix filter.
 * @returns A value carrying the handler descriptor.
 */
export function objectHandler(handlerId: string, bucketId: string, kind: "bucket.object-created" | "bucket.object-deleted", handle: (object: unknown, metadata: unknown) => unknown, prefix?: string): Described<HandlerDescriptor> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id(handlerId), trigger: { kind, resource: { kind: "bucket", id: id(bucketId) }, options: prefix === undefined ? {} : { prefix } } },
    schemas: { object: anySchema },
    invoke: async (input: unknown, context: InvocationContext<unknown>) => handle(input, context.metadata)
  } as HandlerDescriptor);
}

/**
 * Builds a schedule handler.
 *
 * @param handlerId - The handler identifier.
 * @param scheduleId - The schedule it belongs to.
 * @param handle - Runs for every run.
 * @returns A value carrying the handler descriptor.
 */
export function scheduleHandler(handlerId: string, scheduleId: string, handle: (metadata: { readonly scheduledTime: string; readonly trigger?: string }) => unknown): Described<HandlerDescriptor> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id(handlerId), trigger: { kind: "schedule.tick", resource: { kind: "schedule", id: id(scheduleId) }, options: {} } },
    schemas: {},
    invoke: async (_input: unknown, context: InvocationContext<{ readonly scheduledTime: string }>) => handle(context.metadata)
  } as HandlerDescriptor);
}

/**
 * Creates a temporary state directory that a test removes with the returned function.
 *
 * @returns The directory and its cleanup.
 */
export function stateDirectory(): { readonly path: string; readonly remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), "holqa-local-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

/**
 * Creates sequential identifiers, so tests can assert on them.
 *
 * @param prefix - Prepended to every identifier.
 * @returns A function returning `<prefix>1`, `<prefix>2`, ...
 */
export function sequentialIds(prefix = "id-"): () => string {
  let next = 0;
  return () => `${prefix}${++next}`;
}