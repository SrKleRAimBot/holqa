import type {
  BucketAccess,
  BucketDriver,
  HandlerEventPolicy,
  HandlerInvoke,
  InvocationContext,
  InvocationLineage,
  InvocationLogger,
  InvocationTelemetry,
  ListObjectsOptions,
  ObjectEventMetadata,
  ObjectList,
  ObjectMetadata,
  PutObjectOptions,
  ResourceDescriptorOf,
  ResourceId,
  SignedUrl,
  SignedUrlOptions,
  StandardJsonSchemaV1
} from "@holqa/core";

import type {
  HandlerEventOptions,
  IdempotencyOptions,
  ReadIdempotency
} from "@/internal/event-options";
import type {
  AnyResource,
  HandlerRegistration,
  ResourceHandle
} from "@/resources/handle";
import type { CheckResourceId } from "@/types/checks";

import {
  checkObjectKey,
  descriptorKey,
  descriptorProtocol,
  diagnosticCodes,
  failWith,
  HolqaError,
  requireBinding,
  resolveDriver,
  resourceBindingInfo,
  validateInput
} from "@holqa/core";

import {
  DeclarationProblems,
  definedEntries,
  freezeJson,
  requireOptions
} from "@/internal/declaration";
import {
  readEventOptions,
  readIdempotencyOptions,
  runIdempotently
} from "@/internal/event-options";
import { ownerOf } from "@/internal/ownership";

/** The access policies a bucket may require. */
const bucketAccessPolicies: readonly BucketAccess[] = ["private", "public-read"];

/** The largest page a listing may request. */
const maxListLimit = 1000;

/**
 * Options accepted by {@link bucket}.
 *
 * @typeParam Id - The literal identifier.
 */
export interface BucketOptions<Id extends string> {
  /** The persistent identity of the bucket. */
  readonly id: Id;
  /** Who may read stored objects. */
  readonly access: BucketAccess;
}

/** Portable metadata of a created object, independent of any storage service's event format. */
export interface ObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly contentType?: string;
}

/** What remains known about a deleted object. */
export interface DeletedObjectInfo {
  readonly key: string;
}

/**
 * The identity of one object event delivery. Events are delivered at least
 * once and in no guaranteed order; a redelivery has the same `id` and a
 * higher `attempt`, so handlers can discard duplicates by `id`.
 */
export interface ObjectEventInfo {
  /** Stable across redeliveries of the same change. */
  readonly id: string;
  /** When the change happened (ISO 8601, UTC). */
  readonly time: string;
  /** 1 for the first delivery; higher values mean redelivery. */
  readonly attempt: number;
}

/** What an object-created handler receives. */
export interface ObjectCreatedContext {
  readonly object: ObjectInfo;
  readonly event: ObjectEventInfo;
  /** The event's lineage (root operation, cause and depth), when the runtime tracks it. */
  readonly lineage?: InvocationLineage;
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
  /** The invocation's telemetry trace context, for example to pass a `traceparent` header to an outgoing call. Absent when the runtime records no telemetry. */
  readonly telemetry?: InvocationTelemetry;
}

/** What an object-deleted handler receives. */
export interface ObjectDeletedContext {
  readonly object: DeletedObjectInfo;
  readonly event: ObjectEventInfo;
  /** The event's lineage (root operation, cause and depth), when the runtime tracks it. */
  readonly lineage?: InvocationLineage;
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
  /** The invocation's telemetry trace context, for example to pass a `traceparent` header to an outgoing call. Absent when the runtime records no telemetry. */
  readonly telemetry?: InvocationTelemetry;
}

/**
 * What an idempotency key function of an object event handler receives.
 *
 * @typeParam Info - The object description.
 */
export interface ObjectEventIdempotencyContext<Info> {
  readonly object: Info;
  readonly event: ObjectEventInfo;
}

/**
 * Options accepted by {@link BucketHandle.onObjectCreated}.
 *
 * @typeParam HandlerId - The handler's literal identifier.
 */
export interface ObjectCreatedOptions<HandlerId extends string> {
  /** The handler's persistent identity. */
  readonly id: HandlerId;
  /** Only objects whose key starts with this prefix trigger the handler. */
  readonly prefix?: string;
  /** Runs once per delivery. Throwing requests a redelivery. */
  readonly handler: (context: ObjectCreatedContext) => Promise<void> | void;
  /** Event safety declarations: publications analysis cannot see, an intentional cycle, limits. */
  readonly events?: HandlerEventOptions;
  /** Skips events whose idempotency key (default: the event identifier) already completed. Requires a binding with an idempotency store. */
  readonly idempotency?: boolean | IdempotencyOptions<ObjectEventIdempotencyContext<ObjectInfo>>;
}

/**
 * Options accepted by {@link BucketHandle.onObjectDeleted}.
 *
 * @typeParam HandlerId - The handler's literal identifier.
 */
export interface ObjectDeletedOptions<HandlerId extends string> {
  /** The handler's persistent identity. */
  readonly id: HandlerId;
  /** Only objects whose key starts with this prefix trigger the handler. */
  readonly prefix?: string;
  /** Runs once per delivery. Throwing requests a redelivery. */
  readonly handler: (context: ObjectDeletedContext) => Promise<void> | void;
  /** Event safety declarations: publications analysis cannot see, an intentional cycle, limits. */
  readonly events?: HandlerEventOptions;
  /** Skips events whose idempotency key (default: the event identifier) already completed. Requires a binding with an idempotency store. */
  readonly idempotency?: boolean | IdempotencyOptions<ObjectEventIdempotencyContext<DeletedObjectInfo>>;
}

/**
 * A registered object-created handler.
 *
 * @typeParam BucketId - The bucket's identifier.
 * @typeParam HandlerId - The handler's identifier.
 */
export interface ObjectCreatedHandler<BucketId extends string, HandlerId extends string> extends HandlerRegistration<"bucket.object-created", HandlerId, BucketId> {}

/**
 * A registered object-deleted handler.
 *
 * @typeParam BucketId - The bucket's identifier.
 * @typeParam HandlerId - The handler's identifier.
 */
export interface ObjectDeletedHandler<BucketId extends string, HandlerId extends string> extends HandlerRegistration<"bucket.object-deleted", HandlerId, BucketId> {}

/**
 * A typed handle to a declared object storage bucket. Every operation
 * validates the key against the portable key rules (`HOLQA_OBJECT_KEY_INVALID`)
 * and runs through the bound runtime (`HOLQA_RUNTIME_NOT_BOUND` without one).
 *
 * @typeParam Id - The literal identifier.
 */
export interface BucketHandle<Id extends string> extends ResourceHandle<"bucket", Id> {
  /** Stores an object, replacing any object with the same key, and resolves to its metadata. Strings are stored as UTF-8. */
  readonly put: (key: string, body: string | Uint8Array, options?: PutObjectOptions) => Promise<ObjectMetadata>;
  /** Reads an object's bytes; resolves to `undefined` when it does not exist. */
  readonly get: (key: string) => Promise<Uint8Array | undefined>;
  /** Reads an object's metadata without its content; resolves to `undefined` when it does not exist. */
  readonly head: (key: string) => Promise<ObjectMetadata | undefined>;
  /** Removes an object; resolves to `false` when it did not exist. */
  readonly delete: (key: string) => Promise<boolean>;
  /**
   * Lists objects in key order, one bounded page at a time.
   *
   * @throws {HolqaError} `HOLQA_OPERATION_INVALID` for a `limit` outside 1 to 1000 or a malformed `prefix` or `cursor`.
   */
  readonly list: (options?: ListObjectsOptions) => Promise<ObjectList>;
  /**
   * Issues a time-limited URL that lets a client read (`GET`) or write
   * (`PUT`) one object without credentials. What the signature protects
   * against depends on the binding; see its documentation.
   *
   * @throws {HolqaError} `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` when the binding issues no signed URLs or not for that long, or `HOLQA_OPERATION_INVALID` for malformed options.
   */
  readonly signedUrl: (key: string, options: SignedUrlOptions) => Promise<SignedUrl>;
  /** Registers a handler for created (or replaced) objects. Registration is declarative. */
  readonly onObjectCreated: <const HandlerId extends string>(options: ObjectCreatedOptions<HandlerId> & CheckResourceId<HandlerId>) => ObjectCreatedHandler<Id, HandlerId>;
  /** Registers a handler for deleted objects. Registration is declarative. */
  readonly onObjectDeleted: <const HandlerId extends string>(options: ObjectDeletedOptions<HandlerId> & CheckResourceId<HandlerId>) => ObjectDeletedHandler<Id, HandlerId>;
}

/** The portable JSON Schema of the object-created event's fields, shared by both sides. */
const objectInfoProperties = {
  key: { type: "string", minLength: 1 },
  size: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  contentType: { type: "string" }
};

/**
 * A dependency-free Standard Schema for the portable object-created event, so
 * the SDK can validate its own trigger payloads without a schema library. It
 * also implements Standard JSON Schema, so the compiler can record the event
 * contract: unknown properties are accepted on input and removed on output.
 */
const objectInfoSchema: StandardJsonSchemaV1<ObjectInfo> = {
  "~standard": {
    version: 1,
    vendor: "holqa",
    jsonSchema: {
      input: () => ({ type: "object", properties: objectInfoProperties, required: ["key", "size"] }),
      output: () => ({ type: "object", properties: objectInfoProperties, required: ["key", "size"], additionalProperties: false })
    },
    validate: (value) => {
      if (typeof value !== "object" || value === null)
        return { issues: [{ message: "Expected an object event." }] };
      const { key, size, contentType } = value as { readonly key?: unknown; readonly size?: unknown; readonly contentType?: unknown };
      if (typeof key !== "string" || key.length === 0)
        return { issues: [{ message: "Expected a non-empty string.", path: ["key"] }] };
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
        return { issues: [{ message: "Expected a non-negative integer.", path: ["size"] }] };
      if (contentType !== undefined && typeof contentType !== "string")
        return { issues: [{ message: "Expected a string.", path: ["contentType"] }] };
      return { value: { key, size, ...(contentType === undefined ? {} : { contentType }) } };
    }
  }
};

/** The portable JSON Schema of the object-deleted event's fields. */
const deletedObjectProperties = { key: { type: "string", minLength: 1 } };

/** A dependency-free Standard Schema for the portable object-deleted event, described like {@link objectInfoSchema}. */
const deletedObjectSchema: StandardJsonSchemaV1<DeletedObjectInfo> = {
  "~standard": {
    version: 1,
    vendor: "holqa",
    jsonSchema: {
      input: () => ({ type: "object", properties: deletedObjectProperties, required: ["key"] }),
      output: () => ({ type: "object", properties: deletedObjectProperties, required: ["key"], additionalProperties: false })
    },
    validate: (value) => {
      if (typeof value !== "object" || value === null)
        return { issues: [{ message: "Expected an object event." }] };
      const { key } = value as { readonly key?: unknown };
      if (typeof key !== "string" || key.length === 0)
        return { issues: [{ message: "Expected a non-empty string.", path: ["key"] }] };
      return { value: { key } };
    }
  }
};

/**
 * Declares an object storage bucket. Pure: performs no I/O and creates no infrastructure.
 *
 * @param options - Identifier and access policy.
 * @returns A typed bucket handle.
 * @throws {HolqaError} `HOLQA_RESOURCE_ID_INVALID` for an invalid identifier, or `HOLQA_DECLARATION_INVALID` for an unknown access policy.
 */
export function bucket<const Id extends string>(options: BucketOptions<Id> & CheckResourceId<Id>): BucketHandle<Id> {
  const raw = requireOptions(options, "bucket");
  const problems = new DeclarationProblems(`bucket "${String(raw.id)}"`);
  const idCandidate = problems.identifier(raw.id, "bucket id");
  problems.oneOf(raw.access, bucketAccessPolicies, "access");
  const id = problems.valid(idCandidate);

  const descriptor: ResourceDescriptorOf<"bucket"> = Object.freeze({
    protocol: descriptorProtocol,
    type: "resource",
    kind: "bucket",
    id,
    config: freezeJson({}),
    requirements: freezeJson({ access: options.access }),
    schemas: Object.freeze({})
  });

  /**
   * Validates a key and resolves the bucket's driver for one operation.
   *
   * @param self - The bucket handle, which knows its application.
   * @param name - The operation's name, for example `put`.
   * @param key - The untrusted key.
   * @returns The driver and the operation's description.
   * @throws {HolqaError} `HOLQA_OBJECT_KEY_INVALID`, `HOLQA_DECLARATION_INVALID` or `HOLQA_RUNTIME_NOT_BOUND`.
   */
  const prepare = (self: object, name: string, key: unknown): { readonly driver: BucketDriver; readonly operation: string } => {
    const operation = `bucket "${id}" ${name}`;
    const problem = checkObjectKey(key, operation);
    if (problem !== undefined)
      throw new HolqaError(problem);
    return { driver: resolveDriver(ownerOf(self, operation), descriptor, operation), operation };
  };

  const handle: BucketHandle<Id> = Object.freeze({
    [descriptorKey]: descriptor,
    kind: "bucket" as const,
    id: options.id,
    put: async (key: string, body: string | Uint8Array, putOptions?: PutObjectOptions) => {
      const { driver, operation } = prepare(handle, "put", key);
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      if (!(bytes instanceof Uint8Array))
        failWith(diagnosticCodes.operationInvalid, `${operation} needs a string or Uint8Array body.`);
      const contentType = putOptions?.contentType;
      if (contentType !== undefined && (typeof contentType !== "string" || contentType.trim() === ""))
        failWith(diagnosticCodes.operationInvalid, `${operation} needs "contentType" to be a non-empty string.`);
      return driver.put(key, bytes, contentType === undefined ? {} : { contentType });
    },
    get: async (key: string) => prepare(handle, "get", key).driver.get(key),
    head: async (key: string) => prepare(handle, "head", key).driver.head(key),
    delete: async (key: string) => prepare(handle, "delete", key).driver.delete(key),
    list: async (listOptions: ListObjectsOptions = {}) => {
      const operation = `bucket "${id}" list`;
      return resolveDriver(ownerOf(handle, operation), descriptor, operation).list(readListOptions(listOptions, operation));
    },
    signedUrl: async (key: string, urlOptions: SignedUrlOptions) => {
      const { driver, operation } = prepare(handle, "signedUrl", key);
      const checked = readSignedUrlOptions(urlOptions, operation);
      const selected = resourceBindingInfo(requireBinding(ownerOf(handle, operation), operation), descriptor);
      const supported = selected.capabilities.bucket?.signedUrls?.maxExpiresInSeconds;
      if (supported === undefined)
        failWith(diagnosticCodes.bindingCapabilityUnsupported, `Binding "${selected.binding}" does not issue signed URLs, required by ${operation}.`);
      if (checked.expiresInSeconds > supported)
        failWith(diagnosticCodes.bindingCapabilityUnsupported, `Binding "${selected.binding}" issues signed URLs for at most ${supported} seconds; ${operation} asked for ${checked.expiresInSeconds}.`);
      return driver.signUrl(key, checked);
    },
    onObjectCreated: <const HandlerId extends string>(registration: ObjectCreatedOptions<HandlerId> & CheckResourceId<HandlerId>) => {
      const { handlerId, events, idempotency } = readEventRegistration<ObjectInfo>(registration, `object-created handler`, id);
      const invoke: HandlerInvoke<"bucket.object-created"> = eventInvoke(objectInfoSchema, `object event for bucket "${id}"`, { handle, handlerId, idempotency }, (object, event, context) => registration.handler({ object, event, ...context.lineage === undefined ? {} : { lineage: context.lineage }, signal: context.signal, log: context.log, ...context.telemetry === undefined ? {} : { telemetry: context.telemetry } }));
      const handler: ObjectCreatedHandler<Id, HandlerId> = Object.freeze({
        [descriptorKey]: Object.freeze({
          protocol: descriptorProtocol,
          type: "handler" as const,
          definition: freezeJson({
            id: handlerId,
            trigger: { kind: "bucket.object-created" as const, resource: { kind: "bucket" as const, id }, options: definedEntries({ prefix: registration.prefix }) },
            ...definedEntries({ events, idempotency: idempotency?.policy })
          }),
          schemas: Object.freeze({ object: objectInfoSchema }),
          invoke
        }),
        trigger: "bucket.object-created" as const,
        id: registration.id,
        resourceId: options.id
      });
      return handler;
    },
    onObjectDeleted: <const HandlerId extends string>(registration: ObjectDeletedOptions<HandlerId> & CheckResourceId<HandlerId>) => {
      const { handlerId, events, idempotency } = readEventRegistration<DeletedObjectInfo>(registration, `object-deleted handler`, id);
      const invoke: HandlerInvoke<"bucket.object-deleted"> = eventInvoke(deletedObjectSchema, `object event for bucket "${id}"`, { handle, handlerId, idempotency }, (object, event, context) => registration.handler({ object, event, ...context.lineage === undefined ? {} : { lineage: context.lineage }, signal: context.signal, log: context.log, ...context.telemetry === undefined ? {} : { telemetry: context.telemetry } }));
      const handler: ObjectDeletedHandler<Id, HandlerId> = Object.freeze({
        [descriptorKey]: Object.freeze({
          protocol: descriptorProtocol,
          type: "handler" as const,
          definition: freezeJson({
            id: handlerId,
            trigger: { kind: "bucket.object-deleted" as const, resource: { kind: "bucket" as const, id }, options: definedEntries({ prefix: registration.prefix }) },
            ...definedEntries({ events, idempotency: idempotency?.policy })
          }),
          schemas: Object.freeze({ object: deletedObjectSchema }),
          invoke
        }),
        trigger: "bucket.object-deleted" as const,
        id: registration.id,
        resourceId: options.id
      });
      return handler;
    }
  });
  return handle;
}

/**
 * Builds the `invoke` of an object event handler: it validates the portable
 * object description with the event's schema, then runs the user's handler
 * with it and the event's identity.
 *
 * @param schema - The schema of the event's object description.
 * @param subject - What is validated, for messages.
 * @param handler - The bucket, the handler's identifier and its idempotency policy.
 * @param run - Calls the user's handler with the validated object and the event's identity.
 * @returns The `invoke` function.
 */
function eventInvoke<Info>(schema: StandardJsonSchemaV1<Info>, subject: string, handler: EventHandlerIdentity<Info>, run: (object: Info, event: ObjectEventInfo, context: InvocationContext<ObjectEventMetadata>) => Promise<void> | void): (input: unknown, context: InvocationContext<ObjectEventMetadata>) => Promise<unknown> {
  return async (input, context) => {
    const object = await validateInput(schema, input, subject);
    const event = eventInfo(context.metadata);
    const { idempotency, handlerId } = handler;
    if (idempotency === undefined)
      await run(object, event, context);
    else
      await runIdempotently({ app: ownerOf(handler.handle, `handler "${handlerId}"`), handlerId, policy: idempotency.policy, key: idempotency.key === undefined ? event.id : idempotency.key({ object, event }), log: context.log }, () => run(object, event, context));
    return undefined;
  };
}

/**
 * Which handler an object event `invoke` belongs to, for idempotency.
 *
 * @typeParam Info - The object description.
 */
interface EventHandlerIdentity<Info> {
  /** The bucket handle, which knows its application. */
  readonly handle: AnyResource;
  readonly handlerId: ResourceId;
  readonly idempotency: ReadIdempotency<ObjectEventIdempotencyContext<Info>> | undefined;
}

/**
 * Validates the options shared by object event registrations.
 *
 * @param registration - The untrusted registration options.
 * @param label - What is registered, for messages.
 * @param bucketId - The bucket's identifier, for messages.
 * @returns The handler's validated identifier, event policy and idempotency policy.
 * @throws {HolqaError} `HOLQA_RESOURCE_ID_INVALID` or `HOLQA_DECLARATION_INVALID`.
 */
function readEventRegistration<Info>(registration: object, label: string, bucketId: string): { readonly handlerId: ResourceId; readonly events: HandlerEventPolicy | undefined; readonly idempotency: ReadIdempotency<ObjectEventIdempotencyContext<Info>> | undefined } {
  const raw = requireOptions(registration as { readonly id?: unknown; readonly prefix?: unknown; readonly handler?: unknown; readonly events?: unknown; readonly idempotency?: unknown }, `${label} of bucket "${bucketId}"`);
  const problems = new DeclarationProblems(`${label} "${String(raw.id)}" of bucket "${bucketId}"`);
  const handlerIdCandidate = problems.identifier(raw.id, "handler id");
  if (raw.prefix !== undefined && typeof raw.prefix !== "string")
    problems.invalid("\"prefix\" must be a string.");
  if (typeof raw.handler !== "function")
    problems.invalid("\"handler\" must be a function.");
  const events = readEventOptions(raw.events, problems);
  const idempotency = readIdempotencyOptions<ObjectEventIdempotencyContext<Info>>(raw.idempotency, problems);
  return { handlerId: problems.valid(handlerIdCandidate), events, idempotency };
}

/**
 * Converts trusted event metadata into the handler's event description.
 *
 * @param metadata - The runtime's metadata for the delivery.
 * @returns The event's identity, time and attempt.
 */
function eventInfo(metadata: ObjectEventMetadata): ObjectEventInfo {
  return Object.freeze({ id: metadata.eventId, time: metadata.eventTime, attempt: metadata.attempt });
}

/**
 * Validates listing options.
 *
 * @param options - The untrusted options.
 * @param operation - The operation, for messages.
 * @returns The options with `limit` filled in.
 * @throws {HolqaError} `HOLQA_OPERATION_INVALID`.
 */
function readListOptions(options: ListObjectsOptions, operation: string): ListObjectsOptions {
  if (typeof options !== "object" || options === null)
    failWith(diagnosticCodes.operationInvalid, `${operation} options must be an object.`);
  const { prefix, cursor, limit = 100 } = options;
  if (prefix !== undefined && typeof prefix !== "string")
    failWith(diagnosticCodes.operationInvalid, `${operation} needs "prefix" to be a string.`);
  if (cursor !== undefined && (typeof cursor !== "string" || cursor === ""))
    failWith(diagnosticCodes.operationInvalid, `${operation} needs "cursor" to be the cursor of a previous page.`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxListLimit)
    failWith(diagnosticCodes.operationInvalid, `${operation} needs "limit" to be a whole number from 1 to ${maxListLimit}.`);
  return Object.freeze({ limit, ...prefix === undefined ? {} : { prefix }, ...cursor === undefined ? {} : { cursor } });
}

/**
 * Validates signed URL options.
 *
 * @param options - The untrusted options.
 * @param operation - The operation, for messages.
 * @returns A frozen copy of the options.
 * @throws {HolqaError} `HOLQA_OPERATION_INVALID`.
 */
function readSignedUrlOptions(options: SignedUrlOptions, operation: string): SignedUrlOptions {
  if (typeof options !== "object" || options === null)
    failWith(diagnosticCodes.operationInvalid, `${operation} options must be an object.`);
  const { method, expiresInSeconds, contentType } = options;
  if (method !== "GET" && method !== "PUT")
    failWith(diagnosticCodes.operationInvalid, `${operation} needs "method" to be "GET" or "PUT".`);
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1)
    failWith(diagnosticCodes.operationInvalid, `${operation} needs "expiresInSeconds" to be a whole number of at least 1.`);
  if (contentType !== undefined && (method !== "PUT" || typeof contentType !== "string" || contentType.trim() === ""))
    failWith(diagnosticCodes.operationInvalid, `${operation} accepts "contentType" only for PUT, as a non-empty string.`);
  return Object.freeze({ method, expiresInSeconds, ...contentType === undefined ? {} : { contentType } });
}