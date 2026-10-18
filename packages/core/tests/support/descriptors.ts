import type {
  AppDescriptor,
  BindingCapabilities,
  JsonValue,
  MessageEnvelope,
  ResourceDescriptor,
  ResourceDescriptorOf,
  ResourceId,
  RuntimeBinding,
  StandardSchemaV1
} from "@/index";

import { createBindingSlot } from "@/binding/runtime-binding";
import { parseResourceId } from "@/identity/resource-id";

/** A schema that accepts any string, written by hand to avoid a schema library in core tests. */
export const stringSchema: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: value => typeof value === "string" ? { value } : { issues: [{ message: "Expected a string.", path: [] }] }
  }
};

/**
 * Parses an identifier that a test knows to be valid.
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
 * Builds a queue descriptor as a plain object literal, the way another copy of
 * `@holqa/core` or another authoring front end would.
 *
 * @param queueId - The queue identifier.
 * @param requirements - Overrides for the default requirements.
 * @returns A queue descriptor.
 */
export function queueDescriptor(queueId: string, requirements: Partial<ResourceDescriptorOf<"queue">["requirements"]> = {}): ResourceDescriptorOf<"queue"> {
  return {
    protocol: 1,
    type: "resource",
    kind: "queue",
    id: id(queueId),
    config: { schemaVersion: 1 },
    requirements: { delivery: "at-least-once", deadLetter: false, ...requirements },
    schemas: { message: stringSchema }
  };
}

/**
 * Builds a schedule descriptor as a plain object literal.
 *
 * @param scheduleId - The schedule identifier.
 * @returns A schedule descriptor that requires overlapping runs to be skipped.
 */
export function scheduleDescriptor(scheduleId: string): ResourceDescriptorOf<"schedule"> {
  return {
    protocol: 1,
    type: "resource",
    kind: "schedule",
    id: id(scheduleId),
    config: { cron: "0 3 * * *", timezone: "UTC" },
    requirements: { overlap: "skip" },
    schemas: {}
  };
}

/**
 * Builds an application descriptor with an empty binding slot.
 *
 * @param resources - The application's resources.
 * @returns An application descriptor named `demo`.
 */
export function appDescriptor(resources: readonly ResourceDescriptor[]): AppDescriptor {
  return {
    protocol: 1,
    type: "app",
    name: id("demo"),
    handlers: { include: [], exclude: [] },
    resources,
    config: [{ protocol: 1, type: "config", name: "TOKEN", sensitive: true, schema: stringSchema }],
    binding: createBindingSlot()
  };
}

/**
 * Creates a binding that records sent messages and supports every requirement.
 *
 * @param capabilities - Overrides for the advertised capabilities.
 * @returns The binding and the list it records sent payloads into.
 */
export function recordingBinding(capabilities: BindingCapabilities = {}): RuntimeBinding & { readonly sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    name: "recording",
    sent,
    capabilities: {
      "queue": { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true },
      "bucket": { access: ["private"] },
      "schedule": { overlap: ["skip", "allow"] },
      "http.api": {},
      ...capabilities
    },
    drivers: {
      queue: () => ({
        send: async (envelope) => {
          sent.push(envelope.payload);
          return { messageId: `m-${sent.length}` };
        }
      })
    },
    config: entry => `value of ${entry.name}`
  };
}

/**
 * Wraps a payload in a version 1 message envelope.
 *
 * @param payload - The wire payload.
 * @returns The envelope, with schema version 1.
 */
export function envelope(payload: JsonValue): MessageEnvelope {
  return { format: "holqa.message/1", schemaVersion: 1, payload };
}