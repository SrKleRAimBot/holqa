import type {
  DeliveryFailure,
  DeliverySource,
  EventChannel,
  LeasedDelivery
} from "@holqa/core";

import {
  bindingFailure,
  HolqaError
} from "@holqa/core";

import {
  sha256Hex,
  signHeaders,
  uriEncode
} from "@/sigv4";

/** A virtual clock: timers fire only when time is advanced. */
export class VirtualClock {
  private time = Date.UTC(2026, 0, 1);

  /**
   * Returns the current virtual time.
   *
   * @returns Epoch milliseconds.
   */
  readonly now = (): number => this.time;

  /**
   * Moves time forward and lets pending work run.
   *
   * @param ms - How much time passes.
   */
  async advance(ms: number): Promise<void> {
    this.time += ms;
    await Bun.sleep(0);
  }
}

/** One stored object. */
interface StoredObject {
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly etag: string;
  readonly lastModified: Date;
}

/** One queued notification of a subscription. */
interface Queued {
  readonly id: string;
  readonly body: Uint8Array;
  attempts: number;
  visibleAt: number;
  lease?: string;
  dead?: DeliveryFailure;
}

/**
 * An in-memory S3-compatible store: buckets, objects with user metadata,
 * ListObjectsV2 with URL-encoded keys, and S3 event notifications delivered to
 * subscription queues of an event channel. It checks every request's
 * signature with the configured credentials.
 */
export class MemoryS3 {
  readonly clock = new VirtualClock();
  readonly buckets = new Map<string, Map<string, StoredObject>>();
  /** Notification queues by subscription, as provisioning would create them. */
  readonly subscriptions = new Map<string, { readonly bucket: string; readonly queue: Queued[] }>();
  /** Requests answered with this status next, for fault injection. */
  failNext: number | undefined;
  /** Whether notifications carry user metadata, as MinIO's do. */
  includeUserMetadata = true;
  requests = 0;
  private sequence = 0;

  /**
   * Creates a store with credentials it accepts.
   *
   * @param accessKeyId - The accepted access key.
   * @param secretAccessKey - The accepted secret.
   */
  constructor(readonly accessKeyId = "test-access", readonly secretAccessKey = "test-secret") {}

  /**
   * Creates a bucket, as provisioning would.
   *
   * @param bucket - The bucket name.
   */
  createBucket(bucket: string): void {
    this.buckets.set(bucket, this.buckets.get(bucket) ?? new Map());
  }

  /**
   * Creates the notification queue of one subscription, as provisioning would.
   *
   * @param subscription - The channel subscription name.
   * @param bucket - The bucket whose changes it receives.
   */
  createSubscription(subscription: string, bucket: string): void {
    this.subscriptions.set(subscription, { bucket, queue: [] });
  }

  /**
   * Answers one request.
   *
   * @param request - The signed request.
   * @returns The response.
   */
  readonly fetch = async (request: Request): Promise<Response> => {
    this.requests += 1;
    if (this.failNext !== undefined) {
      const status = this.failNext;
      this.failNext = undefined;
      return xmlError(status, status === 503 ? "SlowDown" : "InternalError");
    }
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    const authorization = request.headers.get("authorization") ?? "";
    const signedNames = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(";") ?? [];
    const signed: Record<string, string> = {};
    for (const name of signedNames) {
      if (name !== "host")
        signed[name] = request.headers.get(name) ?? "";
    }
    const date = request.headers.get("x-amz-date") ?? "";
    const when = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    const expected = signHeaders({ method: request.method, url, headers: Object.fromEntries(Object.entries(signed).filter(([name]) => !name.startsWith("x-amz-date") && name !== "x-amz-content-sha256" && name !== "authorization")), payloadHash: request.headers.get("x-amz-content-sha256") ?? sha256Hex(body) }, { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey }, { region: "us-east-1", service: "s3", date: when });
    if (expected.authorization !== authorization)
      return xmlError(403, authorization.includes(`Credential=${this.accessKeyId}/`) ? "SignatureDoesNotMatch" : "InvalidAccessKeyId");
    const [, bucketName, ...rest] = url.pathname.split("/");
    const key = rest.map(segment => decodeURIComponent(segment)).join("/");
    const bucket = this.buckets.get(bucketName ?? "");
    if (bucket === undefined)
      return xmlError(404, "NoSuchBucket");
    if (key === "") {
      if (request.method === "HEAD")
        return new Response(null, { status: 200 });
      return this.list(bucket, url);
    }
    switch (request.method) {
      case "PUT": {
        const headers: Record<string, string> = {};
        request.headers.forEach((value, name) => {
          if (name === "content-type" || name.startsWith("x-amz-meta-"))
            headers[name] = value;
        });
        const etag = sha256Hex(body).slice(0, 32);
        bucket.set(key, { body, headers, etag, lastModified: new Date(this.clock.now()) });
        this.notify(bucketName!, "s3:ObjectCreated:Put", key, body.length, etag, headers);
        return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
      }
      case "GET":
      case "HEAD": {
        const found = bucket.get(key);
        if (found === undefined)
          return request.method === "HEAD" ? new Response(null, { status: 404 }) : xmlError(404, "NoSuchKey");
        return new Response(request.method === "HEAD" ? null : found.body, { headers: { ...found.headers, "etag": `"${found.etag}"`, "content-length": String(found.body.length), "last-modified": found.lastModified.toUTCString() } });
      }
      case "DELETE":
        if (bucket.delete(key))
          this.notify(bucketName!, "s3:ObjectRemoved:Delete", key, undefined, undefined, {});
        return new Response(null, { status: 204 });
      default:
        return xmlError(405, "MethodNotAllowed");
    }
  };

  /**
   * Answers ListObjectsV2.
   *
   * @param bucket - The bucket's objects.
   * @param url - The request URL.
   * @returns The XML listing.
   */
  private list(bucket: Map<string, StoredObject>, url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? "";
    const limit = Number(url.searchParams.get("max-keys") ?? "1000");
    const start = Number(url.searchParams.get("continuation-token") ?? "0");
    const encoder = new TextEncoder();
    const keys = [...bucket.keys()].filter(key => key.startsWith(prefix)).sort((left, right) => Buffer.compare(encoder.encode(left), encoder.encode(right)));
    const page = keys.slice(start, start + limit);
    const contents = page.map((key) => {
      const object = bucket.get(key)!;
      return `<Contents><Key>${uriEncode(key, true)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>&quot;${object.etag}&quot;</ETag><Size>${object.body.length}</Size></Contents>`;
    }).join("");
    const truncated = start + limit < keys.length;
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${start + limit}</NextContinuationToken>` : ""}</ListBucketResult>`, { headers: { "content-type": "application/xml" } });
  }

  /**
   * Publishes an S3 event notification to every subscription of a bucket.
   *
   * @param bucket - The bucket name.
   * @param eventName - The S3 event type, such as `s3:ObjectCreated:Put`.
   * @param key - The object key.
   * @param size - The object size, for creations.
   * @param etag - The object etag, for creations.
   * @param headers - The object's headers, for user metadata.
   */
  private notify(bucket: string, eventName: string, key: string, size: number | undefined, etag: string | undefined, headers: Readonly<Record<string, string>>): void {
    const sequencer = String(++this.sequence).padStart(16, "0");
    const userMetadata = Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith("x-amz-meta-")).map(([name, value]) => [name.replace(/^x-amz-meta-/, "X-Amz-Meta-"), value]));
    const record = { eventName, eventTime: new Date(this.clock.now()).toISOString(), s3: { bucket: { name: bucket }, object: { key: encodeURIComponent(key).replaceAll("%2F", "/").replaceAll("%20", "+"), ...size === undefined ? {} : { size }, ...etag === undefined ? {} : { eTag: etag }, sequencer, ...this.includeUserMetadata ? { userMetadata } : {} } } };
    const bytes = new TextEncoder().encode(JSON.stringify({ EventName: eventName, Key: `${bucket}/${key}`, Records: [record] }));
    for (const subscription of this.subscriptions.values()) {
      if (subscription.bucket === bucket)
        subscription.queue.push({ id: `n-${this.sequence}`, body: bytes, attempts: 0, visibleAt: this.clock.now() });
    }
  }

  /**
   * Creates an event channel that delivers this store's notifications.
   *
   * @returns A channel over the subscription queues.
   */
  channel(): EventChannel {
    return Object.freeze({
      channel: "example.memory-events",
      description: "in-memory notification queues",
      open: async () => ({
        subscribe: async (subscription: string): Promise<DeliverySource<Uint8Array>> => {
          const found = this.subscriptions.get(subscription);
          if (found === undefined)
            throw new HolqaError(bindingFailure("failed", { binding: "memory-events", message: `No notification queue for "${subscription}".` }));
          return this.source(found.queue);
        }
      })
    });
  }

  /**
   * Creates a leased delivery source over one notification queue.
   *
   * @param queue - The subscription's pending notifications.
   * @returns A source leasing from the queue.
   */
  private source(queue: Queued[]): DeliverySource<Uint8Array> {
    /**
     * Finds a delivery by its current receipt.
     *
     * @param receipt - The receipt issued when leasing.
     * @returns The delivery, when its lease is current.
     */
    const leased = (receipt: string): Queued | undefined => queue.find(item => item.lease === receipt && item.visibleAt > this.clock.now() && item.dead === undefined);
    /**
     * Removes a delivery.
     *
     * @param item - The delivery.
     */
    const remove = (item: Queued): void => {
      queue.splice(queue.indexOf(item), 1);
    };
    return {
      receive: async ({ max, leaseMs }) => {
        const deliveries: Array<LeasedDelivery<Uint8Array>> = [];
        for (const item of queue) {
          if (deliveries.length >= max || item.dead !== undefined || item.visibleAt > this.clock.now())
            continue;
          item.attempts += 1;
          item.lease = `${item.id}:${item.attempts}`;
          item.visibleAt = this.clock.now() + leaseMs;
          deliveries.push({ receipt: item.lease, id: item.id, attempt: item.attempts, body: item.body });
        }
        return deliveries;
      },
      acknowledge: async (receipt) => {
        const item = leased(receipt);
        if (item !== undefined)
          remove(item);
        return item !== undefined;
      },
      retry: async (receipt, delayMs) => {
        const item = leased(receipt);
        if (item === undefined)
          return false;
        item.visibleAt = this.clock.now() + delayMs;
        delete item.lease;
        return true;
      },
      deadLetter: async (receipt, failure) => {
        const item = leased(receipt);
        if (item !== undefined)
          item.dead = failure;
        return item !== undefined;
      },
      discard: async (receipt) => {
        const item = leased(receipt);
        if (item !== undefined)
          remove(item);
        return item !== undefined;
      },
      wait: async () => {
        await Bun.sleep(1);
      }
    };
  }
}

/**
 * Builds an S3 error response.
 *
 * @param status - The HTTP status.
 * @param code - The S3 error code.
 * @returns The response.
 */
function xmlError(status: number, code: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`, { status, headers: { "content-type": "application/xml" } });
}