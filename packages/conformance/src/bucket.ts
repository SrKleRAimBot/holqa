import type {
  BucketCapabilities,
  BucketDriver,
  DeliverySource,
  LeasedDelivery,
  ObjectEvent,
  ObjectEventSource,
  ObjectEventSubscription
} from "@holqa/core";

import type {
  ConformanceCase,
  ConformanceSuite,
  ConformanceTime
} from "@/suite";

import {
  ConformanceSkip,
  eventually,
  expectEqual,
  expectThat
} from "@/suite";

/** One fresh, empty bucket of the provider under test. */
export interface BucketFixture {
  readonly driver: BucketDriver;
  /** What the provider advertises for the bucket. */
  readonly capabilities: BucketCapabilities;
  /** The bucket's object event source, when the provider delivers events. */
  readonly events?: ObjectEventSource;
  /** The bucket's identifier, as events report it. */
  readonly bucketId: string;
  readonly close: () => Promise<void>;
}

/** What the bucket and object event cases need. */
export interface BucketHarness {
  /** Opens a fresh, empty bucket for one case. */
  readonly open: () => Promise<BucketFixture>;
  readonly time: ConformanceTime;
  /** How long to wait for an expected event, in milliseconds of harness time. Default 10 000. */
  readonly patienceMs?: number;
  /** The lease used by cases that let a lease expire, in milliseconds. Default 1 000. */
  readonly leaseMs?: number;
  /**
   * Prepares the infrastructure of a subscription before a case subscribes,
   * for providers whose subscriptions are provisioned (for example a
   * notification queue per subscription). Optional.
   */
  readonly provisionSubscription?: (bucket: BucketFixture, subscription: ObjectEventSubscription) => Promise<void>;
}

/**
 * Runs a case against a fresh bucket and always closes it.
 *
 * @param harness - What the cases need to reach the provider.
 * @param body - The case.
 */
async function withBucket(harness: BucketHarness, body: (bucket: BucketFixture) => Promise<void>): Promise<void> {
  const bucket = await harness.open();
  try {
    await body(bucket);
  } finally {
    await bucket.close();
  }
}

/** Text encoding for object bodies. */
const encoder = new TextEncoder();

/** The contract name of the bucket cases. */
const storage = "bucket";

/**
 * The normative behaviour of the `bucket` contract (version 1): object
 * writes, reads, metadata, deletion, ordered paged listing and signed URLs.
 */
export const bucketConformance: ConformanceSuite<BucketHarness> = Object.freeze({
  contract: storage,
  cases: Object.freeze<ConformanceCase<BucketHarness>[]>([
    {
      name: "a stored object reads back byte for byte with its metadata",
      run: harness => withBucket(harness, async (bucket) => {
        const body = new Uint8Array(70_000).map((_, index) => (index * 31) % 256);
        const stored = await bucket.driver.put("reports/2026/data.bin", body, { contentType: "application/octet-stream" });
        expectEqual(storage, { key: stored.key, size: stored.size, contentType: stored.contentType }, { key: "reports/2026/data.bin", size: body.length, contentType: "application/octet-stream" }, "The metadata put returns");
        expectThat(storage, typeof stored.etag === "string" && stored.etag !== "", "put must return a non-empty etag.");
        expectThat(storage, !Number.isNaN(Date.parse(stored.lastModified)), "lastModified must be an ISO 8601 time.");
        expectEqual(storage, await bucket.driver.get("reports/2026/data.bin"), body, "The bytes get returns");
        const head = await bucket.driver.head("reports/2026/data.bin");
        expectEqual(storage, head === undefined ? undefined : { key: head.key, size: head.size, contentType: head.contentType, etag: head.etag }, { key: stored.key, size: stored.size, contentType: "application/octet-stream", etag: stored.etag }, "The metadata head returns");
      })
    },
    {
      name: "keys with spaces and non-ASCII characters are stored and listed as given",
      run: harness => withBucket(harness, async (bucket) => {
        const key = "documents/Größe und ünïcödé 文件 #1 (copy).txt";
        await bucket.driver.put(key, encoder.encode("text"), { contentType: "text/plain; charset=utf-8" });
        expectEqual(storage, await bucket.driver.get(key), encoder.encode("text"), "The bytes of a non-ASCII key");
        expectEqual(storage, (await bucket.driver.list({ prefix: "documents/" })).objects.map(object => object.key), [key], "The listed keys");
      })
    },
    {
      name: "a missing object reads as undefined and deleting it resolves to false",
      run: harness => withBucket(harness, async (bucket) => {
        expectEqual(storage, await bucket.driver.get("missing.txt"), undefined, "get of a missing object");
        expectEqual(storage, await bucket.driver.head("missing.txt"), undefined, "head of a missing object");
        expectEqual(storage, await bucket.driver.delete("missing.txt"), false, "delete of a missing object");
      })
    },
    {
      name: "overwriting an object replaces its bytes and changes its etag",
      run: harness => withBucket(harness, async (bucket) => {
        const first = await bucket.driver.put("item.txt", encoder.encode("one"), {});
        const second = await bucket.driver.put("item.txt", encoder.encode("two!"), {});
        expectThat(storage, first.etag !== second.etag, "Different content must have a different etag.");
        expectEqual(storage, await bucket.driver.get("item.txt"), encoder.encode("two!"), "The bytes after an overwrite");
        expectEqual(storage, (await bucket.driver.head("item.txt"))?.size, 4, "The size after an overwrite");
      })
    },
    {
      name: "a deleted object is gone",
      run: harness => withBucket(harness, async (bucket) => {
        await bucket.driver.put("gone.txt", encoder.encode("x"), {});
        expectEqual(storage, await bucket.driver.delete("gone.txt"), true, "delete of an existing object");
        expectEqual(storage, await bucket.driver.get("gone.txt"), undefined, "get after delete");
        expectEqual(storage, (await bucket.driver.list({})).objects.length, 0, "The number of listed objects after delete");
      })
    },
    {
      name: "listing is sorted by key, filtered by prefix and paged with a cursor",
      run: harness => withBucket(harness, async (bucket) => {
        const keys = ["b/2.txt", "a/1.txt", "b/1.txt", "b/10.txt", "c.txt"];
        for (const key of keys)
          await bucket.driver.put(key, encoder.encode(key), {});
        expectEqual(storage, (await bucket.driver.list({})).objects.map(object => object.key), ["a/1.txt", "b/1.txt", "b/10.txt", "b/2.txt", "c.txt"], "The keys of a full listing");
        const first = await bucket.driver.list({ prefix: "b/", limit: 2 });
        expectEqual(storage, first.objects.map(object => object.key), ["b/1.txt", "b/10.txt"], "The first page");
        expectThat(storage, first.cursor !== undefined, "A page followed by more keys must have a cursor.");
        const second = await bucket.driver.list({ prefix: "b/", limit: 2, cursor: first.cursor });
        expectEqual(storage, second.objects.map(object => object.key), ["b/2.txt"], "The second page");
        expectEqual(storage, second.cursor, undefined, "The cursor of the last page");
      })
    },
    {
      name: "signed URLs carry their method, expiry and required headers",
      run: harness => withBucket(harness, async (bucket) => {
        const maximum = bucket.capabilities.signedUrls?.maxExpiresInSeconds;
        if (maximum === undefined)
          throw new ConformanceSkip("The provider issues no signed URLs.");
        const before = harness.time.now?.() ?? Date.now();
        const signed = await bucket.driver.signUrl("upload.txt", { method: "PUT", expiresInSeconds: Math.min(60, maximum), contentType: "text/plain" });
        expectEqual(storage, signed.method, "PUT", "The signed URL's method");
        expectThat(storage, URL.canParse(signed.url), "A signed URL must be an absolute URL.");
        expectEqual(storage, signed.headers["content-type"], "text/plain", "The required content-type header");
        const expires = Date.parse(signed.expiresAt);
        expectThat(storage, expires > before && expires <= before + (Math.min(60, maximum) + 5) * 1000, "expiresAt must be the requested time from now.");
      })
    }
  ])
});

/** The contract name of the object event cases. */
const events = "bucket.events";

/**
 * Subscribes to a bucket's events, provisioning the subscription first when the harness needs to.
 *
 * @param harness - What the cases need to reach the provider.
 * @param bucket - The bucket under test.
 * @param subscription - The handler subscription to receive events for.
 * @returns The subscription's delivery source.
 */
async function subscribe(harness: BucketHarness, bucket: BucketFixture, subscription: ObjectEventSubscription): Promise<DeliverySource<ObjectEvent>> {
  if (bucket.events === undefined || (bucket.capabilities.events ?? []).length === 0)
    throw new ConformanceSkip("The provider delivers no object events.");
  await harness.provisionSubscription?.(bucket, subscription);
  return bucket.events.subscribe(subscription);
}

/**
 * Receives one event that must arrive.
 *
 * @param harness - What the cases need to reach the provider.
 * @param source - The subscription's source.
 * @param what - What is expected, for the failure message.
 * @param leaseMs - The lease to request.
 * @returns The leased delivery that arrived.
 */
async function expectEvent(harness: BucketHarness, source: DeliverySource<ObjectEvent>, what: string, leaseMs = 30_000): Promise<LeasedDelivery<ObjectEvent>> {
  const delivery = await eventually(harness.time, harness.patienceMs ?? 10_000, async () => (await source.receive({ max: 1, leaseMs }))[0]);
  expectThat(events, delivery !== undefined, `${what} was not delivered within ${harness.patienceMs ?? 10_000} ms.`);
  return delivery;
}

/**
 * The normative behaviour of the `bucket.events` contract (version 1):
 * `holqa.object-event/1` envelopes per subscription, filtered by type and
 * prefix, with stable identifiers across redeliveries.
 */
export const bucketEventsConformance: ConformanceSuite<BucketHarness> = Object.freeze({
  contract: events,
  cases: Object.freeze<ConformanceCase<BucketHarness>[]>([
    {
      name: "writing an object delivers an object.created event with the object's identity",
      run: harness => withBucket(harness, async (bucket) => {
        const source = await subscribe(harness, bucket, { id: "conformance.created", types: ["object.created"] });
        const stored = await bucket.driver.put("in/a.txt", encoder.encode("hello"), { contentType: "text/plain" });
        const delivery = await expectEvent(harness, source, "The object.created event");
        const event = delivery.body;
        expectEqual(events, { format: event.format, type: event.type, bucket: event.bucket, key: event.object.key }, { format: "holqa.object-event/1", type: "object.created", bucket: bucket.bucketId, key: "in/a.txt" }, "The event");
        expectEqual(events, event.type === "object.created" ? event.object.size : undefined, 5, "The event's object size");
        expectThat(events, event.type !== "object.created" || event.object.etag === undefined || event.object.etag === stored.etag || event.object.etag.replaceAll("\"", "") === stored.etag.replaceAll("\"", ""), "The event's etag must match the stored object's.");
        expectEqual(events, delivery.id, event.id, "The delivery identifier and the event identifier");
        expectThat(events, !Number.isNaN(Date.parse(event.time)), "The event time must be an ISO 8601 time.");
        await source.acknowledge(delivery.receipt);
      })
    },
    {
      name: "deleting an object delivers an object.deleted event",
      run: harness => withBucket(harness, async (bucket) => {
        if (!(bucket.capabilities.events ?? []).includes("object.deleted"))
          throw new ConformanceSkip("The provider does not deliver object.deleted events.");
        const source = await subscribe(harness, bucket, { id: "conformance.deleted", types: ["object.deleted"] });
        await bucket.driver.put("in/b.txt", encoder.encode("x"), {});
        await bucket.driver.delete("in/b.txt");
        const delivery = await expectEvent(harness, source, "The object.deleted event");
        expectEqual(events, { type: delivery.body.type, key: delivery.body.object.key }, { type: "object.deleted", key: "in/b.txt" }, "The event");
      })
    },
    {
      name: "a subscription receives only its event types and keys under its prefix",
      run: harness => withBucket(harness, async (bucket) => {
        const source = await subscribe(harness, bucket, { id: "conformance.prefixed", types: ["object.created"], prefix: "keep/" });
        await bucket.driver.put("skip/x.txt", encoder.encode("x"), {});
        await bucket.driver.put("keep/y.txt", encoder.encode("y"), {});
        const delivery = await expectEvent(harness, source, "The event under the prefix");
        expectEqual(events, delivery.body.object.key, "keep/y.txt", "The only delivered key");
        await source.acknowledge(delivery.receipt);
        await harness.time.advance(500);
        expectEqual(events, (await source.receive({ max: 10, leaseMs: 30_000 })).length, 0, "Deliveries outside the prefix");
      })
    },
    {
      name: "two subscriptions each receive their own copy and settle it independently",
      run: harness => withBucket(harness, async (bucket) => {
        const first = await subscribe(harness, bucket, { id: "conformance.first", types: ["object.created"] });
        const second = await subscribe(harness, bucket, { id: "conformance.second", types: ["object.created"] });
        await bucket.driver.put("shared.txt", encoder.encode("x"), {});
        const a = await expectEvent(harness, first, "The first subscription's event");
        const b = await expectEvent(harness, second, "The second subscription's event");
        expectEqual(events, a.body.id, b.body.id, "The event identifier seen by both subscriptions");
        await first.acknowledge(a.receipt);
        expectEqual(events, await second.acknowledge(b.receipt), true, "acknowledge by the second subscription after the first acknowledged");
      })
    },
    {
      name: "an event whose lease expires is delivered again with the same identifier",
      run: harness => withBucket(harness, async (bucket) => {
        const source = await subscribe(harness, bucket, { id: "conformance.redelivered", types: ["object.created"] });
        await bucket.driver.put("again.txt", encoder.encode("x"), {});
        const leaseMs = harness.leaseMs ?? 1_000;
        const first = await expectEvent(harness, source, "The event", leaseMs);
        await harness.time.advance(leaseMs);
        const second = await expectEvent(harness, source, "The redelivered event");
        expectEqual(events, second.body.id, first.body.id, "The redelivered event's identifier");
        expectThat(events, second.attempt > first.attempt, "A redelivery must have a higher attempt.");
      })
    }
  ])
});