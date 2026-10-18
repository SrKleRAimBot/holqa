import type { StandardSchemaV1 } from "@/schema/standard-schema";

// Every resource kind is described by one entry in `ResourceKindMap`. Each
// entry fixes five typed facets, so adding a kind (topics, WebSocket endpoints,
// workflows, ...) means adding interfaces and one map entry, not a new architecture:
//
// - config:       normalized, JSON-only settings that describe what the resource is;
// - requirements: behaviour a binding must guarantee (the capability contract);
// - schemas:      the Standard Schemas the resource declares, by role;
// - capabilities: what a binding advertises, compared with `requirements`;
// - driver:       data-plane operations a runtime binding provides (`never` when
//                 the kind has no operations of its own).

/**
 * The facets that describe one resource kind.
 *
 * @typeParam Config - Normalized JSON-only settings.
 * @typeParam Requirements - Behaviour a binding must guarantee.
 * @typeParam Schemas - Schemas by role.
 * @typeParam Capabilities - What a binding advertises for this kind.
 * @typeParam Driver - Data-plane operations, or `never`.
 */
export interface ResourceKindSpec<Config, Requirements, Schemas, Capabilities, Driver> {
  readonly config: Config;
  readonly requirements: Requirements;
  readonly schemas: Schemas;
  readonly capabilities: Capabilities;
  readonly driver: Driver;
}

/** Delivery guarantees a queue can require. Only at-least-once delivery is defined today. */
export type QueueDeliveryGuarantee = "at-least-once";

/** Normalized queue settings. */
export interface QueueConfig {
  /** Version of the message contract; incremented when the schema changes incompatibly. */
  readonly schemaVersion: number;
}

/** Behaviour a queue requires from its binding. */
export interface QueueRequirements {
  readonly delivery: QueueDeliveryGuarantee;
  /** Total delivery attempts before a message is dead-lettered or dropped. Absent means the binding's default. */
  readonly maxAttempts?: number;
  /** Whether messages that exhaust their attempts must be kept in a dead-letter destination. */
  readonly deadLetter: boolean;
}

/** Schemas a queue declares. */
export interface QueueSchemas {
  /** The message contract: producers send its input type, consumers receive its output type. */
  readonly message: StandardSchemaV1;
}

/** What a binding advertises for queues. */
export interface QueueCapabilities {
  readonly delivery: readonly QueueDeliveryGuarantee[];
  /** The largest `maxAttempts` the binding can honour. */
  readonly maxAttempts: number;
  readonly deadLetter: boolean;
}

/** Data-plane queue operations. Messages arrive already validated, in their input (wire) form. */
export interface QueueDriver {
  readonly send: (message: unknown) => Promise<void>;
}

/** Who may read objects in a bucket. */
export type BucketAccess = "private" | "public-read";

/** Normalized bucket settings. Buckets have none yet beyond their requirements. */
export interface BucketConfig {}

/** Behaviour a bucket requires from its binding. */
export interface BucketRequirements {
  readonly access: BucketAccess;
}

/** Schemas a bucket declares. Buckets store opaque bytes and declare none. */
export interface BucketSchemas {}

/** What a binding advertises for buckets. */
export interface BucketCapabilities {
  readonly access: readonly BucketAccess[];
}

/** Optional metadata stored with an object. */
export interface PutObjectOptions {
  /** The MIME type stored with the object. */
  readonly contentType?: string;
}

/** Data-plane bucket operations. */
export interface BucketDriver {
  readonly put: (key: string, body: string | Uint8Array, options?: PutObjectOptions) => Promise<void>;
  readonly get: (key: string) => Promise<Uint8Array | undefined>;
}

/** What happens when a scheduled run is due while the previous run is still in progress. */
export type ScheduleOverlap = "skip" | "allow";

/** Normalized schedule settings. */
export interface ScheduleConfig {
  /** A five-field cron expression. */
  readonly cron: string;
  /** An IANA time zone name, for example `UTC` or `Europe/Berlin`. */
  readonly timezone: string;
}

/** Behaviour a schedule requires from its binding. */
export interface ScheduleRequirements {
  readonly overlap: ScheduleOverlap;
}

/** Schedules declare no schemas. */
export interface ScheduleSchemas {}

/** What a binding advertises for schedules. */
export interface ScheduleCapabilities {
  readonly overlap: readonly ScheduleOverlap[];
}

/** Documentation metadata of an HTTP API. */
export interface HttpApiDocs {
  readonly title: string;
  readonly version: string;
}

/** Normalized HTTP API settings. */
export interface HttpApiConfig {
  /** Path prefix for every route: `/` or a path that starts with `/` and does not end with one. */
  readonly basePath: string;
  readonly docs?: HttpApiDocs;
}

/** HTTP APIs require no behaviour beyond serving their routes. */
export interface HttpApiRequirements {}

/** HTTP APIs declare no resource-level schemas; routes declare their own. */
export interface HttpApiSchemas {}

/** What a binding advertises for HTTP APIs. Nothing is negotiated yet. */
export interface HttpApiCapabilities {}

/**
 * The registry of resource kinds understood by this version of the descriptor
 * protocol, keyed by kind name. Readers treat kinds missing from their copy of
 * the registry as unsupported rather than guessing at their shape.
 */
export interface ResourceKindMap {
  readonly "queue": ResourceKindSpec<QueueConfig, QueueRequirements, QueueSchemas, QueueCapabilities, QueueDriver>;
  readonly "bucket": ResourceKindSpec<BucketConfig, BucketRequirements, BucketSchemas, BucketCapabilities, BucketDriver>;
  readonly "schedule": ResourceKindSpec<ScheduleConfig, ScheduleRequirements, ScheduleSchemas, ScheduleCapabilities, never>;
  readonly "http.api": ResourceKindSpec<HttpApiConfig, HttpApiRequirements, HttpApiSchemas, HttpApiCapabilities, never>;
}

/** The name of a resource kind, for example `queue` or `http.api`. */
export type ResourceKind = keyof ResourceKindMap;

/** Resource kinds whose handles perform operations through a runtime driver. */
export type DrivenResourceKind = {
  [Kind in ResourceKind]: [ResourceKindMap[Kind]["driver"]] extends [never] ? never : Kind
}[ResourceKind];

/** Every registered resource kind. The `satisfies` clause fails to compile when a kind is missing. */
const kindSet = {
  "queue": true,
  "bucket": true,
  "schedule": true,
  "http.api": true
} as const satisfies Record<ResourceKind, true>;

/** Every resource kind this version of the protocol defines, in a stable order. */
export const resourceKinds: readonly ResourceKind[] = Object.freeze(Object.keys(kindSet) as ResourceKind[]);

/**
 * Reports whether a value names a resource kind this version of the protocol defines.
 *
 * @param value - A candidate kind, typically read from an untrusted descriptor.
 * @returns `true` for a registered kind name.
 */
export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === "string" && Object.hasOwn(kindSet, value);
}