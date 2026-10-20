import type {
  AppDescriptor,
  ProviderContext,
  ResourceDescriptorOf
} from "@holqa/core";

import type { S3BucketsOptions } from "@/provider";

import {
  bucketConformance,
  bucketEventsConformance,
  registerConformance
} from "@holqa/conformance";
import {
  createBindingSlot,
  credentialRef,
  diagnosticsOf,
  parseResourceId,
  validateProvider
} from "@holqa/core";
import { MemoryS3 } from "@test/support/memory-s3";

import {
  describe,
  expect,
  it
} from "bun:test";

import { s3 } from "@/provider";

/** The bucket every test uses. */
const files: ResourceDescriptorOf<"bucket"> = { protocol: 1, type: "resource", kind: "bucket", id: (parseResourceId("files") as { value: ResourceDescriptorOf<"bucket">["id"] }).value, config: {}, requirements: { access: "private" }, schemas: {} };

/** The application every test uses. */
const app: AppDescriptor = { protocol: 1, type: "app", name: files.id, handlers: { include: [], exclude: [] }, resources: [files], config: [], binding: createBindingSlot() };

/**
 * Builds the context a provider is opened with.
 *
 * @param values - Credential values by name.
 * @returns A context resolving credentials from `values`.
 */
function contextOf(values: Readonly<Record<string, string>> = { S3_ACCESS_KEY_ID: "test-access", S3_SECRET_ACCESS_KEY: "test-secret" }): ProviderContext {
  return { app, environment: "test", resources: [files], credential: reference => values[reference.name] ?? "", signal: new AbortController().signal, log: () => {} };
}

/**
 * Creates the provider for an in-memory store.
 *
 * @param store - The in-memory store requests go to.
 * @param options - Settings to override.
 * @returns An `s3.buckets` provider wired to the store.
 */
function providerFor(store: MemoryS3, options: Partial<S3BucketsOptions> = {}) {
  return s3.buckets({ endpoint: "http://s3.test", accessKeyId: credentialRef("S3_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_SECRET_ACCESS_KEY"), fetch: store.fetch, events: { channel: store.channel() }, ...options });
}

/**
 * Opens the provider on a fresh store with the bucket created.
 *
 * @param options - Settings to override.
 * @returns The store, provider and the bucket's driver and event source.
 */
async function openOn(options: Partial<S3BucketsOptions> = {}) {
  const store = new MemoryS3();
  store.createBucket("files");
  const provider = providerFor(store, options);
  const instance = await provider.open(contextOf());
  return { store, provider, instance, driver: instance.drivers!.bucket!(files), events: instance.sources?.bucket?.(files) };
}

/**
 * Collects the codes a promise rejects with.
 *
 * @param promise - A promise expected to reject with a Holqa error.
 * @returns The diagnostic codes.
 */
async function rejection(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return diagnosticsOf(error).map(diagnostic => diagnostic.code);
  }
  return [];
}

describe("s3.buckets on an in-memory store", () => {
  let store = new MemoryS3();
  const harness = {
    time: { advance: (ms: number) => store.clock.advance(ms) },
    open: async () => {
      const opened = await openOn();
      store = opened.store;
      return { driver: opened.driver, ...opened.events === undefined ? {} : { events: opened.events }, capabilities: opened.provider.resources.bucket, bucketId: "files", close: async () => {} };
    },
    provisionSubscription: async (_bucket: unknown, subscription: { readonly id: string }) => store.createSubscription(`files.${subscription.id}`, "files")
  };
  registerConformance(bucketConformance, harness, { describe, it });
  registerConformance(bucketEventsConformance, harness, { describe, it });
});

describe("s3.buckets", () => {
  it("declares storage and events separately and honestly", () => {
    const store = new MemoryS3();
    const withEvents = providerFor(store);
    expect(validateProvider(withEvents)).toEqual([]);
    expect(withEvents.contracts).toEqual({ "bucket": 1, "bucket.events": 1 });
    expect(withEvents.resources.bucket).toEqual({ access: ["private"], signedUrls: { maxExpiresInSeconds: 604_800 }, events: ["object.created", "object.deleted"] });
    const storageOnly = s3.buckets({ endpoint: "http://s3.test", accessKeyId: credentialRef("S3_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_SECRET_ACCESS_KEY") });
    expect(validateProvider(storageOnly)).toEqual([]);
    expect(storageOnly.contracts).toEqual({ bucket: 1 });
    expect(storageOnly.resources.bucket).toEqual({ access: ["private"], signedUrls: { maxExpiresInSeconds: 604_800 } });
    expect(storageOnly.topology).toEqual({ delivery: "none", state: "shared" });
    expect(storageOnly.credentials?.map(reference => reference.name)).toEqual(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
  });

  it("rejects malformed settings, including credentials that are not references", () => {
    let codes: string[] = [];
    try {
      s3.buckets({ endpoint: "http://user:pass@s3.test", accessKeyId: "AKIA" as never, secretAccessKey: credentialRef("S3_SECRET_ACCESS_KEY"), buckets: { files: "Bad_Name" } });
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_BINDING_CONFIG_INVALID", "HOLQA_BINDING_CONFIG_INVALID", "HOLQA_BINDING_CONFIG_INVALID"]);
  });

  it("classifies a missing bucket, rejected credentials and an unavailable service", async () => {
    const store = new MemoryS3();
    expect(await rejection(providerFor(store).open(contextOf()))).toEqual(["HOLQA_BINDING_FAILED"]);
    store.createBucket("files");
    expect(await rejection(providerFor(store).open(contextOf({ S3_ACCESS_KEY_ID: "test-access", S3_SECRET_ACCESS_KEY: "wrong" })))).toEqual(["HOLQA_BINDING_CREDENTIALS_INVALID"]);
    store.failNext = 503;
    expect(await rejection(providerFor(store).open(contextOf()))).toEqual(["HOLQA_BINDING_UNAVAILABLE"]);
    const unreachable = providerFor(store, { fetch: async () => {
      throw new TypeError("connect ECONNREFUSED");
    } });
    expect(await rejection(unreachable.open(contextOf()))).toEqual(["HOLQA_BINDING_UNAVAILABLE"]);
  });

  it("issues presigned URLs the store accepts", async () => {
    const { store, driver } = await openOn();
    const signed = await driver.signUrl("upload.txt", { method: "PUT", expiresInSeconds: 60, contentType: "text/plain" });
    expect(new URL(signed.url).searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(signed.headers).toEqual({ "content-type": "text/plain" });
    expect(store.requests).toBeGreaterThan(0);
  });

  it("propagates the writer's trace through notifications that carry user metadata, with or without the header prefix", async () => {
    const { store, driver, events } = await openOn();
    store.createSubscription("files.traced", "files");
    const source = await events!.subscribe({ id: "traced", types: ["object.created"] });
    const trace = { correlationId: "c-1", causationId: "inv-1", rootId: "inv-1", depth: 1 };
    await driver.put("a.txt", new TextEncoder().encode("x"), {}, { trace });
    const [delivery] = await source.receive({ max: 1, leaseMs: 1_000 });
    expect(delivery?.trace).toEqual(trace);
    store.userMetadataPrefix = "";
    await driver.put("c.txt", new TextEncoder().encode("x"), {}, { trace });
    await store.clock.advance(2_000);
    expect((await source.receive({ max: 5, leaseMs: 1_000 })).find(item => item.body.object.key === "c.txt")?.trace).toEqual(trace);
    store.includeUserMetadata = false;
    await driver.put("b.txt", new TextEncoder().encode("x"), {}, { trace });
    await store.clock.advance(2_000);
    const later = await source.receive({ max: 5, leaseMs: 1_000 });
    expect(later.find(item => item.body.object.key === "b.txt")?.trace).toBeUndefined();
  });

  it("dead-letters notifications it cannot read", async () => {
    const { store, events } = await openOn();
    store.createSubscription("files.raw", "files");
    store.subscriptions.get("files.raw")!.queue.push({ id: "bad", body: new TextEncoder().encode("{}"), attempts: 0, visibleAt: 0 });
    const source = await events!.subscribe({ id: "raw", types: ["object.created"] });
    expect(await source.receive({ max: 1, leaseMs: 1_000 })).toEqual([]);
    expect(store.subscriptions.get("files.raw")!.queue[0]!.dead?.code).toBe("HOLQA_PAYLOAD_MALFORMED");
  });

  it("refuses to attach to a subscription whose notification queue does not exist", async () => {
    const { events } = await openOn();
    expect(await rejection(events!.subscribe({ id: "missing", types: ["object.created"] }))).toEqual(["HOLQA_BINDING_FAILED"]);
  });
});