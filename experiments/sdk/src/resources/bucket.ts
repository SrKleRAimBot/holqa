import type {
  Described,
  HandlerDescriptor,
  InvocationLogger,
  ResourceDescriptor,
  StandardSchemaV1
} from "@holqa/experiment-model";

import {
  descriptorKey,
  requireBinding,
  validateInput
} from "@holqa/experiment-model";

import {
  definedEntries,
  handlerDescriptor,
  resourceDescriptor
} from "@/internal/describe";
import { ownerOf } from "@/internal/ownership";

/** Who may read objects in a bucket. */
export type BucketAccess = "private" | "public-read";

/** Options accepted by {@link bucket}. */
export interface BucketOptions<Id extends string> {
  readonly id: Id;
  readonly access: BucketAccess;
}

/** Portable metadata of a stored object, independent of any storage provider's event format. */
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

/** Options accepted by {@link BucketHandle.onObjectCreated}. */
export interface ObjectCreatedOptions<HandlerId extends string> {
  readonly id: HandlerId;
  /** Only objects whose key starts with this prefix trigger the handler. */
  readonly prefix?: string;
  readonly handler: (context: ObjectCreatedContext) => Promise<void> | void;
}

/** A registered object-created handler. */
export interface ObjectCreatedHandler<BucketId extends string, HandlerId extends string> extends Described<HandlerDescriptor> {
  readonly kind: "bucket.object-created";
  readonly id: HandlerId;
  readonly bucketId: BucketId;
}

/** A typed handle to a declared bucket. */
export interface BucketHandle<Id extends string> extends Described<ResourceDescriptor> {
  readonly kind: "bucket";
  readonly id: Id;
  /**
   * Stores an object.
   *
   * @param key - The object key.
   * @param body - The object contents.
   * @param options - Optional object metadata.
   * @param options.contentType - The MIME type stored with the object.
   * @returns Resolves when the object is stored.
   */
  put: (key: string, body: string | Uint8Array, options?: { readonly contentType?: string }) => Promise<void>;
  /**
   * Reads an object.
   *
   * @param key - The object key.
   * @returns The contents, or `undefined` when the object does not exist.
   */
  get: (key: string) => Promise<Uint8Array | undefined>;
  /**
   * Registers a handler for newly created objects.
   *
   * @param options - Handler identifier, optional key prefix and function.
   * @returns The handler registration.
   */
  onObjectCreated: <const HandlerId extends string>(options: ObjectCreatedOptions<HandlerId>) => ObjectCreatedHandler<Id, HandlerId>;
}

/**
 * A dependency-free Standard Schema for portable object events. It shows that
 * the SDK can validate its own trigger payloads without a schema library.
 */
const objectInfoSchema: StandardSchemaV1<ObjectInfo> = {
  "~standard": {
    version: 1,
    vendor: "holqa",
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
 * Declares an object storage bucket.
 *
 * @param options - Identifier and access policy.
 * @returns A typed bucket handle.
 */
export function bucket<const Id extends string>(options: BucketOptions<Id>): BucketHandle<Id> {
  const handle: BucketHandle<Id> = {
    [descriptorKey]: resourceDescriptor("bucket", options.id, { access: options.access }, {}),
    kind: "bucket",
    id: options.id,
    put: async (key, body, putOptions) => {
      const binding = requireBinding(ownerOf(handle, `bucket "${options.id}" put`), `bucket "${options.id}" put`);
      await binding.bucket(options.id).put(key, body, putOptions);
    },
    get: async (key) => {
      const binding = requireBinding(ownerOf(handle, `bucket "${options.id}" get`), `bucket "${options.id}" get`);
      return binding.bucket(options.id).get(key);
    },
    onObjectCreated: registration => Object.freeze({
      [descriptorKey]: handlerDescriptor(
        registration.id,
        { kind: "bucket.object-created", resource: options.id, ...definedEntries({ prefix: registration.prefix }) },
        {},
        {},
        async (input, context) => {
          const object = await validateInput(objectInfoSchema, input, `object event for bucket "${options.id}"`);
          await registration.handler({ object, signal: context.signal, log: context.log });
          return undefined;
        }
      ),
      kind: "bucket.object-created" as const,
      id: registration.id,
      bucketId: options.id
    })
  };
  return Object.freeze(handle);
}