import type { Activity } from "@/drivers/activity";

/** How the runtime lets the bucket driver reach the current generation. */
export interface BucketPort {
  /** The object-created handlers of a bucket in the current generation. */
  readonly objectCreatedHandlers: (bucketId: string) => readonly { readonly id: string; readonly prefix: string | undefined }[];
  /** Invokes a handler through the runtime. */
  readonly deliver: (handlerId: string, event: unknown) => Promise<unknown>;
}

/** A failed object-created delivery. Storage events are not retried by this emulator. */
export interface EventFailure {
  readonly handlerId: string;
  readonly key: string;
  readonly error: unknown;
}

/** A stored object. */
interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string | undefined;
}

/**
 * An in-memory object store that emits portable object-created events. Each
 * `put` notifies every matching handler once; failures are recorded, not
 * retried, and event order is not guaranteed. Production storage events may be
 * duplicated or reordered, so handlers must not rely on this emulator's
 * exactly-once notification.
 */
export class InMemoryBuckets {
  private readonly buckets = new Map<string, Map<string, StoredObject>>();
  /** Failed event deliveries, for inspection. */
  readonly failures: EventFailure[] = [];

  /**
   * Creates the bucket driver.
   *
   * @param port - Access to the current generation's handlers.
   * @param activity - Tracks event deliveries for `idle()`.
   */
  constructor(private readonly port: BucketPort, private readonly activity: Activity) {}

  /**
   * Stores a copy of an object and notifies matching object-created handlers.
   *
   * @param bucketId - The bucket identifier.
   * @param key - The object key.
   * @param body - The contents.
   * @param contentType - The MIME type, if known.
   */
  put(bucketId: string, key: string, body: string | Uint8Array, contentType: string | undefined): void {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body.slice();
    this.bucket(bucketId).set(key, { body: bytes, contentType });
    const event = { key, size: bytes.byteLength, ...(contentType === undefined ? {} : { contentType }) };
    for (const handler of this.port.objectCreatedHandlers(bucketId)) {
      if (handler.prefix !== undefined && !key.startsWith(handler.prefix))
        continue;
      void this.activity.track(async () => {
        try {
          await this.port.deliver(handler.id, event);
        } catch (error) {
          this.failures.push({ handlerId: handler.id, key, error });
        }
      });
    }
  }

  /**
   * Reads a copy of an object.
   *
   * @param bucketId - The bucket identifier.
   * @param key - The object key.
   * @returns The contents, or `undefined` when the object does not exist.
   */
  get(bucketId: string, key: string): Uint8Array | undefined {
    return this.bucket(bucketId).get(key)?.body.slice();
  }

  /**
   * Returns a bucket's object table, creating it on first use.
   *
   * @param bucketId - The bucket identifier.
   * @returns The mutable table.
   */
  private bucket(bucketId: string): Map<string, StoredObject> {
    let bucket = this.buckets.get(bucketId);
    if (bucket === undefined) {
      bucket = new Map();
      this.buckets.set(bucketId, bucket);
    }
    return bucket;
  }
}