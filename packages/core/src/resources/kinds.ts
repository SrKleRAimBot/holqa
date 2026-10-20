import type { DeliveryTrace } from "@/binding/trace";
import type { StandardSchemaV1 } from "@/schema/standard-schema";
import type { MessageEnvelope } from "@/wire/message-envelope";

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

/** How the delay before a redelivery grows: constant, or doubling (by `multiplier`) per failed attempt. */
export type QueueBackoffStrategy = "fixed" | "exponential";

/** A constant delay before every redelivery. */
export interface FixedQueueBackoff {
  readonly strategy: "fixed";
  /** Seconds between a failed attempt and the next delivery. */
  readonly delaySeconds: number;
}

/** A delay that grows with every failed attempt, up to a ceiling. */
export interface ExponentialQueueBackoff {
  readonly strategy: "exponential";
  /** Seconds before the second attempt. */
  readonly initialDelaySeconds: number;
  /** The longest delay between two attempts, in seconds. */
  readonly maxDelaySeconds: number;
  /** The factor applied per further failed attempt. Absent means 2. */
  readonly multiplier?: number;
}

/**
 * The delay between a failed delivery and the next attempt. Delays are
 * computed without jitter, so they are reproducible in tests; a binding may
 * deliver later than requested, never earlier.
 */
export type QueueBackoff = FixedQueueBackoff | ExponentialQueueBackoff;

/** Behaviour a queue requires from its binding. */
export interface QueueRequirements {
  readonly delivery: QueueDeliveryGuarantee;
  /** Total delivery attempts before a message is dead-lettered or dropped. Absent means the binding's default. */
  readonly maxAttempts?: number;
  /** Whether messages that exhaust their attempts must be kept in a dead-letter destination. */
  readonly deadLetter: boolean;
  /** The delay before redeliveries. Absent means the runtime's default backoff. */
  readonly backoff?: QueueBackoff;
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
  /** Backoff strategies the binding honours. Absent means none: a queue that declares `backoff` cannot be bound. */
  readonly backoff?: readonly QueueBackoffStrategy[];
  /**
   * The longest delay, in seconds, the binding can apply to a sent message or
   * a redelivery. Absent means no delayed delivery: sends with a delay fail.
   */
  readonly maxDelaySeconds?: number;
  /**
   * The largest message the binding accepts, in bytes of the serialized
   * `holqa.message/1` envelope (UTF-8 JSON). Absent means no limit beyond the
   * binding's infrastructure. Sends of larger messages fail before they reach the driver.
   */
  readonly maxMessageBytes?: number;
}

/** Settings of one queue send. */
export interface QueueSendOptions {
  /** Seconds to wait before the message becomes deliverable. Absent or `0` means at once. */
  readonly delaySeconds?: number;
}

/**
 * What a runtime tells a driver about the invocation that performs an
 * operation. Drivers may ignore it; a driver that stores deliveries should keep
 * `trace` with them and return it from its source (see `LeasedDelivery.trace`).
 * It is never part of the application's resource contract.
 */
export interface DriverOperationContext {
  /** The trace of the invocation performing the operation. */
  readonly trace?: DeliveryTrace;
}

/** What a queue returns for an accepted message. */
export interface QueueSendReceipt {
  /** The identifier the queue assigned. Every delivery of the message, including duplicates, carries it. */
  readonly messageId: string;
}

/**
 * Data-plane queue operations. The envelope's payload is already validated
 * and in its input (wire) form; the driver stores the envelope unchanged and
 * assigns the message identifier.
 */
export interface QueueDriver {
  readonly send: (envelope: MessageEnvelope, options: QueueSendOptions, context?: DriverOperationContext) => Promise<QueueSendReceipt>;
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
  /** Object event types the binding delivers to handlers. Absent means none. */
  readonly events?: readonly ObjectEventType[];
  /** Signed URL support: the longest expiry the binding can issue. Absent means no signed URLs. */
  readonly signedUrls?: { readonly maxExpiresInSeconds: number };
}

/** The kinds of change an object event reports. */
export type ObjectEventType = "object.created" | "object.deleted";

/** Optional metadata stored with an object. */
export interface PutObjectOptions {
  /** The MIME type stored with the object. */
  readonly contentType?: string;
}

/** Portable metadata of a stored object. */
export interface ObjectMetadata {
  readonly key: string;
  /** Size in bytes. */
  readonly size: number;
  readonly contentType?: string;
  /**
   * An opaque version tag that changes whenever the object's content changes.
   * Its format differs between bindings; compare tags only for equality.
   */
  readonly etag: string;
  /** When the object was last written (ISO 8601, UTC). */
  readonly lastModified: string;
}

/** Settings of a bucket listing. */
export interface ListObjectsOptions {
  /** Only keys that start with this prefix. */
  readonly prefix?: string;
  /** Where to continue: the `cursor` of the previous page. */
  readonly cursor?: string;
  /** The largest page, between 1 and 1000. Absent means 100. */
  readonly limit?: number;
}

/** One page of a bucket listing, sorted by key in UTF-8 byte order. */
export interface ObjectList {
  readonly objects: readonly ObjectMetadata[];
  /** Present when more keys follow; pass it as `cursor` to read the next page. */
  readonly cursor?: string;
}

/** What a signed URL allows: reading an object or writing it. */
export type SignedUrlMethod = "GET" | "PUT";

/** Settings of a signed URL. */
export interface SignedUrlOptions {
  readonly method: SignedUrlMethod;
  /** How long the URL is valid, in seconds; at least 1. */
  readonly expiresInSeconds: number;
  /** For `PUT`: the content type the upload must declare. */
  readonly contentType?: string;
}

/**
 * A time-limited URL that lets a client without credentials read or write
 * one object. What a signature proves (and whether it can be revoked) is a
 * property of the binding that issued it; see the binding's documentation.
 */
export interface SignedUrl {
  readonly url: string;
  readonly method: SignedUrlMethod;
  /** When the URL stops working (ISO 8601, UTC). */
  readonly expiresAt: string;
  /** Headers the client must send with the request, for example `content-type`. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Data-plane bucket operations. Keys are validated before a driver sees them (see `checkObjectKey`). */
export interface BucketDriver {
  /** Stores an object. `context` carries the trace an object event should record. */
  readonly put: (key: string, body: Uint8Array, options: PutObjectOptions, context?: DriverOperationContext) => Promise<ObjectMetadata>;
  readonly get: (key: string) => Promise<Uint8Array | undefined>;
  readonly head: (key: string) => Promise<ObjectMetadata | undefined>;
  /** Removes an object; resolves to `false` when it did not exist. */
  readonly delete: (key: string, context?: DriverOperationContext) => Promise<boolean>;
  readonly list: (options: ListObjectsOptions) => Promise<ObjectList>;
  readonly signUrl: (key: string, options: SignedUrlOptions) => Promise<SignedUrl>;
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

/** Normalized static site settings. */
export interface StaticSiteConfig {
  /**
   * Where the built artifacts are, relative to the application root, for
   * example `web/dist`. A build step (Vite, another bundler) writes them; Holqa
   * only serves them.
   */
  readonly directory: string;
  /** The URL path prefix the site is served under: `/` or a path that starts with `/` and does not end with one. */
  readonly basePath: string;
}

/** Behaviour a static site requires from its binding. */
export interface StaticSiteRequirements {
  /**
   * Whether requests for paths that name no file and have no file extension
   * are answered with the site's `index.html`, so a single-page application's
   * client-side router can handle them.
   */
  readonly spaFallback: boolean;
}

/** Static sites declare no schemas. */
export interface StaticSiteSchemas {}

/** What a binding advertises for static sites. */
export interface StaticSiteCapabilities {
  /** Whether the binding can answer unknown extension-less paths with `index.html`. */
  readonly spaFallback: boolean;
}

/** Data-plane operations of a static site: answering requests for its files. */
export interface StaticSiteDriver {
  /**
   * Answers a `GET` or `HEAD` request for a path relative to the site's base
   * path (`/` for the root), or resolves to `undefined` when the site has no
   * file for it and no fallback applies. Responses carry a content type
   * derived from the file name.
   */
  readonly fetch: (path: string, request: Request) => Promise<Response | undefined>;
}

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
  readonly "static.site": ResourceKindSpec<StaticSiteConfig, StaticSiteRequirements, StaticSiteSchemas, StaticSiteCapabilities, StaticSiteDriver>;
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
  "http.api": true,
  "static.site": true
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