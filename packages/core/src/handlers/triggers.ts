import type { EmptyObject } from "@/json";
import type { ResourceKind } from "@/resources/kinds";
import type { StandardSchemaV1 } from "@/schema/standard-schema";

// Every trigger kind is described by one entry in `TriggerKindMap`, in the
// same way resource kinds are: the kind of resource it belongs to, its
// JSON-only options, the schemas it validates input with, and the trusted
// metadata the runtime passes with each invocation.

/**
 * The facets that describe one trigger kind.
 *
 * @typeParam Resource - The kind of resource the trigger belongs to.
 * @typeParam Options - JSON-only trigger settings, readable without running user code.
 * @typeParam Schemas - Schemas the handler validates untrusted input with, by role.
 * @typeParam Metadata - Trusted per-invocation data supplied by the runtime.
 */
export interface TriggerKindSpec<Resource extends ResourceKind, Options, Schemas, Metadata> {
  readonly resource: Resource;
  readonly options: Options;
  readonly schemas: Schemas;
  readonly metadata: Metadata;
}

/** HTTP methods a route may declare. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Options of a queue consumer. */
export interface QueueMessageTriggerOptions {
  /** Maximum concurrent invocations of this consumer. Absent means the runtime's default. */
  readonly concurrency?: number;
}

/** Schemas a queue consumer validates with. */
export interface QueueMessageTriggerSchemas {
  readonly message: StandardSchemaV1;
}

/** Runtime metadata of one queue delivery. */
export interface QueueMessageMetadata {
  /** 1 for the first delivery; higher values mean redelivery. */
  readonly attempt: number;
  readonly messageId: string;
}

/** Options of an object-created handler. */
export interface ObjectCreatedTriggerOptions {
  /** Only objects whose key starts with this prefix trigger the handler. */
  readonly prefix?: string;
}

/** Schemas an object-created handler validates its portable event with. */
export interface ObjectCreatedTriggerSchemas {
  readonly object: StandardSchemaV1;
}

/** Runtime metadata of one scheduled run. */
export interface ScheduleTickMetadata {
  /** The time the run was scheduled for (ISO 8601), not the time it started. */
  readonly scheduledTime: string;
}

/** Options of an HTTP route. Route execution is planned; the trigger shape is reserved now. */
export interface HttpRouteTriggerOptions {
  readonly method: HttpMethod;
  /** Path relative to the API's base path. `:name` segments are parameters. */
  readonly path: string;
}

/** Schemas an HTTP route validates requests and responses with. */
export interface HttpRouteTriggerSchemas {
  readonly params?: StandardSchemaV1;
  readonly query?: StandardSchemaV1;
  readonly body?: StandardSchemaV1;
  /** Response schemas keyed by HTTP status code. */
  readonly responses: Readonly<{ [status: number]: StandardSchemaV1 }>;
}

/**
 * The registry of trigger kinds understood by this version of the descriptor
 * protocol, keyed by trigger name.
 */
export interface TriggerKindMap {
  readonly "queue.message": TriggerKindSpec<"queue", QueueMessageTriggerOptions, QueueMessageTriggerSchemas, QueueMessageMetadata>;
  readonly "bucket.object-created": TriggerKindSpec<"bucket", ObjectCreatedTriggerOptions, ObjectCreatedTriggerSchemas, EmptyObject>;
  readonly "schedule.tick": TriggerKindSpec<"schedule", EmptyObject, EmptyObject, ScheduleTickMetadata>;
  readonly "http.route": TriggerKindSpec<"http.api", HttpRouteTriggerOptions, HttpRouteTriggerSchemas, EmptyObject>;
}

/** The name of a trigger kind, for example `queue.message`. */
export type TriggerKind = keyof TriggerKindMap;

/** Every registered trigger kind mapped to the resource kind it belongs to. */
const triggerResourceKinds = {
  "queue.message": "queue",
  "bucket.object-created": "bucket",
  "schedule.tick": "schedule",
  "http.route": "http.api"
} as const satisfies { readonly [Trigger in TriggerKind]: TriggerKindMap[Trigger]["resource"] };

/** Every trigger kind this version of the protocol defines, in a stable order. */
export const triggerKinds: readonly TriggerKind[] = Object.freeze(Object.keys(triggerResourceKinds) as TriggerKind[]);

/**
 * Reports whether a value names a trigger kind this version of the protocol defines.
 *
 * @param value - A candidate trigger kind, typically read from an untrusted descriptor.
 * @returns `true` for a registered trigger kind.
 */
export function isTriggerKind(value: unknown): value is TriggerKind {
  return typeof value === "string" && Object.hasOwn(triggerResourceKinds, value);
}

/**
 * Returns the resource kind a trigger kind belongs to, so that graph checks can
 * verify that a handler's resource reference points at the right kind.
 *
 * @param trigger - A registered trigger kind.
 * @returns The resource kind, for example `queue` for `queue.message`.
 */
export function resourceKindOfTrigger<Trigger extends TriggerKind>(trigger: Trigger): TriggerKindMap[Trigger]["resource"] {
  return triggerResourceKinds[trigger];
}