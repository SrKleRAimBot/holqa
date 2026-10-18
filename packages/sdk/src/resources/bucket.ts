import type {
  BucketAccess,
  HandlerInvoke,
  InvocationLogger,
  PutObjectOptions,
  ResourceDescriptorOf,
  StandardJsonSchemaV1
} from "@holqa/core";

import type {
  HandlerRegistration,
  ResourceHandle
} from "@/resources/handle";
import type { CheckResourceId } from "@/types/checks";

import {
  descriptorKey,
  descriptorProtocol,
  resolveDriver,
  validateInput
} from "@holqa/core";

import {
  DeclarationProblems,
  definedEntries,
  freezeJson,
  requireOptions
} from "@/internal/declaration";
import { ownerOf } from "@/internal/ownership";

/** The access policies a bucket may require. */
const bucketAccessPolicies: readonly BucketAccess[] = ["private", "public-read"];

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

/** Portable metadata of a stored object, independent of any storage service's event format. */
export interface ObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly contentType?: string;
}

/** What an object-created handler receives. */
export interface ObjectCreatedContext {
  readonly object: ObjectInfo;
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
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
  readonly handler: (context: ObjectCreatedContext) => Promise<void> | void;
}

/**
 * A registered object-created handler.
 *
 * @typeParam BucketId - The bucket's identifier.
 * @typeParam HandlerId - The handler's identifier.
 */
export interface ObjectCreatedHandler<BucketId extends string, HandlerId extends string> extends HandlerRegistration<"bucket.object-created", HandlerId, BucketId> {}

/**
 * A typed handle to a declared object storage bucket.
 *
 * @typeParam Id - The literal identifier.
 */
export interface BucketHandle<Id extends string> extends ResourceHandle<"bucket", Id> {
  /** Stores an object through the bound runtime. */
  readonly put: (key: string, body: string | Uint8Array, options?: PutObjectOptions) => Promise<void>;
  /** Reads an object through the bound runtime; resolves to `undefined` when it does not exist. */
  readonly get: (key: string) => Promise<Uint8Array | undefined>;
  /** Registers a handler for newly created objects. Registration is declarative. */
  readonly onObjectCreated: <const HandlerId extends string>(options: ObjectCreatedOptions<HandlerId> & CheckResourceId<HandlerId>) => ObjectCreatedHandler<Id, HandlerId>;
}

/** The portable JSON Schema of the object event's fields, shared by both sides. */
const objectInfoProperties = {
  key: { type: "string", minLength: 1 },
  size: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  contentType: { type: "string" }
};

/**
 * A dependency-free Standard Schema for the portable object event, so the SDK
 * can validate its own trigger payloads without a schema library. It also
 * implements Standard JSON Schema, so the compiler can record the event
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

  const handle: BucketHandle<Id> = Object.freeze({
    [descriptorKey]: descriptor,
    kind: "bucket" as const,
    id: options.id,
    put: async (key: string, body: string | Uint8Array, putOptions?: PutObjectOptions) => {
      const operation = `bucket "${id}" put`;
      await resolveDriver(ownerOf(handle, operation), descriptor, operation).put(key, body, putOptions);
    },
    get: async (key: string) => {
      const operation = `bucket "${id}" get`;
      return resolveDriver(ownerOf(handle, operation), descriptor, operation).get(key);
    },
    onObjectCreated: <const HandlerId extends string>(registration: ObjectCreatedOptions<HandlerId> & CheckResourceId<HandlerId>) => {
      const rawRegistration = requireOptions(registration, `object-created handler of bucket "${id}"`);
      const registrationProblems = new DeclarationProblems(`object-created handler "${String(rawRegistration.id)}" of bucket "${id}"`);
      const handlerIdCandidate = registrationProblems.identifier(rawRegistration.id, "handler id");
      if (rawRegistration.prefix !== undefined && typeof rawRegistration.prefix !== "string")
        registrationProblems.invalid("\"prefix\" must be a string.");
      if (typeof rawRegistration.handler !== "function")
        registrationProblems.invalid("\"handler\" must be a function.");
      const handlerId = registrationProblems.valid(handlerIdCandidate);

      /**
       * Validates the portable object event and runs the handler with it.
       *
       * @param input - The untrusted object event from the runtime.
       * @param context - The invocation context.
       * @returns `undefined` once the handler has finished.
       */
      const invoke: HandlerInvoke<"bucket.object-created"> = async (input, context) => {
        const object = await validateInput(objectInfoSchema, input, `object event for bucket "${id}"`);
        await registration.handler({ object, signal: context.signal, log: context.log });
        return undefined;
      };
      const handler: ObjectCreatedHandler<Id, HandlerId> = Object.freeze({
        [descriptorKey]: Object.freeze({
          protocol: descriptorProtocol,
          type: "handler" as const,
          definition: freezeJson({
            id: handlerId,
            trigger: { kind: "bucket.object-created" as const, resource: { kind: "bucket" as const, id }, options: definedEntries({ prefix: registration.prefix }) }
          }),
          schemas: Object.freeze({ object: objectInfoSchema }),
          invoke
        }),
        trigger: "bucket.object-created" as const,
        id: registration.id,
        resourceId: options.id
      });
      return handler;
    }
  });
  return handle;
}