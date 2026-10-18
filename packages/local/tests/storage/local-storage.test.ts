import type {
  BucketDriver,
  ObjectEvent,
  ResourceDescriptorOf
} from "@holqa/core";

import type { LocalEnvironment } from "@/environment";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  application,
  bucketResource,
  sequentialIds,
  stateDirectory
} from "@test/support/fixtures";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import { ManualClock } from "@/clock";
import { createLocalEnvironment } from "@/environment";

/** Cleanups to run after each test. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup();
});

/** The buckets every test declares. */
const files = bucketResource("files") as ResourceDescriptorOf<"bucket">;

/** A public bucket. */
const assets = bucketResource("assets", "public-read") as ResourceDescriptorOf<"bucket">;

/**
 * Creates an environment with both buckets.
 *
 * @returns The environment, its driver for `files`, its clock and its directory.
 */
async function setup(): Promise<{ readonly env: LocalEnvironment; readonly bucket: BucketDriver; readonly clock: ManualClock; readonly directory: string }> {
  const directory = stateDirectory();
  cleanups.push(directory.remove);
  const clock = new ManualClock(Date.parse("2026-10-18T10:00:00.000Z"));
  const env = await createLocalEnvironment({ app: application([files, assets]), directory: directory.path, clock, createId: sequentialIds(), env: {}, storage: { signedUrlBase: "http://local.test/_holqa/storage", maxUploadBytes: 16 } });
  cleanups.push(() => env.close());
  return { env, bucket: env.binding.drivers.bucket!(files), clock, directory: directory.path };
}

/** UTF-8 encoder. */
const encoder = new TextEncoder();

describe("local object storage", () => {
  it("stores, reads, inspects, replaces and deletes objects", async () => {
    const { bucket, directory } = await setup();
    const stored = await bucket.put("docs/a.txt", encoder.encode("hello"), { contentType: "text/plain" });
    expect(stored).toEqual({ key: "docs/a.txt", size: 5, contentType: "text/plain", etag: expect.any(String), lastModified: "2026-10-18T10:00:00.000Z" });
    expect(new TextDecoder().decode(await bucket.get("docs/a.txt"))).toBe("hello");
    const replaced = await bucket.put("docs/a.txt", encoder.encode("hello again"), {});
    expect(replaced.etag).not.toBe(stored.etag);
    expect(await bucket.head("docs/a.txt")).toMatchObject({ size: 11 });
    expect(readdirSync(join(directory, "objects", "files"))).toHaveLength(1);
    expect(await bucket.delete("docs/a.txt")).toBe(true);
    expect(await bucket.delete("docs/a.txt")).toBe(false);
    expect(await bucket.get("docs/a.txt")).toBeUndefined();
    expect(readdirSync(join(directory, "objects", "files"))).toHaveLength(0);
  });

  it("names files by a hash of the key, so keys never become paths", async () => {
    const { bucket, directory } = await setup();
    await bucket.put("..%2F..%2Fescape/../../x", encoder.encode("x"), {});
    expect(readdirSync(join(directory, "objects", "files")).every(name => /^[0-9a-f]{32}\.id-\d+$/.test(name))).toBe(true);
  });

  it("lists in bounded pages with a cursor, filtered by prefix", async () => {
    const { bucket } = await setup();
    for (const key of ["a/1", "a/2", "a/3", "b/1"])
      await bucket.put(key, encoder.encode(key), {});
    const first = await bucket.list({ prefix: "a/", limit: 2 });
    expect(first.objects.map(object => object.key)).toEqual(["a/1", "a/2"]);
    const second = await bucket.list({ prefix: "a/", limit: 2, cursor: first.cursor! });
    expect(second.objects.map(object => object.key)).toEqual(["a/3"]);
    expect(second.cursor).toBeUndefined();
    expect((await bucket.list({ limit: 10 })).objects).toHaveLength(4);
    await expect(bucket.list({ cursor: "not a cursor!" })).rejects.toThrow("HOLQA_OPERATION_INVALID");
    await expect(bucket.list({ prefix: "b/", cursor: first.cursor! })).rejects.toThrow("HOLQA_OPERATION_INVALID");
  });

  it("emits created and deleted events to matching subscriptions, each with its own identity", async () => {
    const { env, bucket } = await setup();
    const source = env.binding.sources!.bucket!(files);
    const created = await source.subscribe({ id: "files.created", types: ["object.created"], prefix: "raw/" });
    const deleted = await source.subscribe({ id: "files.deleted", types: ["object.deleted"] });
    await bucket.put("raw/a.txt", encoder.encode("abc"), { contentType: "text/plain" });
    await bucket.put("other/b.txt", encoder.encode("b"), {});
    await bucket.put("raw/a.txt", encoder.encode("abcd"), {});
    await bucket.delete("raw/a.txt");
    await bucket.delete("never-existed");
    const createdEvents = await created.receive({ max: 10, leaseMs: 1_000 });
    expect(createdEvents.map(delivery => delivery.body)).toEqual([
      { format: "holqa.object-event/1", id: "id-2", type: "object.created", bucket: "files", time: "2026-10-18T10:00:00.000Z", object: { key: "raw/a.txt", size: 3, contentType: "text/plain", etag: expect.any(String) } },
      { format: "holqa.object-event/1", id: "id-6", type: "object.created", bucket: "files", time: "2026-10-18T10:00:00.000Z", object: { key: "raw/a.txt", size: 4, etag: expect.any(String) } }
    ] as ObjectEvent[]);
    expect((await deleted.receive({ max: 10, leaseMs: 1_000 })).map(delivery => delivery.body.object)).toEqual([{ key: "raw/a.txt" }]);
    expect(env.storage.events("files").map(({ event, deliveries }) => `${event.type}:${event.object.key}:${deliveries.map(delivery => delivery.subscription).join("+")}`)).toEqual([
      "object.created:raw/a.txt:files.created",
      "object.created:other/b.txt:",
      "object.created:raw/a.txt:files.created",
      "object.deleted:raw/a.txt:files.deleted"
    ]);
  });

  it("serves signed downloads and uploads until they expire, and emits events for uploads", async () => {
    const { env, bucket, clock } = await setup();
    await bucket.put("report.txt", encoder.encode("secret"), { contentType: "text/plain" });
    const download = await bucket.signUrl("report.txt", { method: "GET", expiresInSeconds: 60 });
    expect(download).toMatchObject({ method: "GET", expiresAt: "2026-10-18T10:01:00.000Z", headers: {} });
    expect(env.storage.handles(new Request(download.url))).toBe(true);
    const response = await env.storage.fetch(new Request(download.url));
    expect([response.status, response.headers.get("content-type"), await response.text()]).toEqual([200, "text/plain", "secret"]);
    const upload = await bucket.signUrl("uploads/new.txt", { method: "PUT", expiresInSeconds: 60, contentType: "text/plain" });
    expect(upload.headers).toEqual({ "content-type": "text/plain" });
    const put = await env.storage.fetch(new Request(upload.url, { method: "PUT", headers: upload.headers, body: "uploaded" }));
    expect(put.status).toBe(200);
    expect(new TextDecoder().decode(await bucket.get("uploads/new.txt"))).toBe("uploaded");
    expect(env.storage.events("files").at(-1)?.event).toMatchObject({ type: "object.created", object: { key: "uploads/new.txt", contentType: "text/plain" } });
    clock.advance(60_000);
    const expired = await env.storage.fetch(new Request(download.url));
    expect([expired.status, ((await expired.json()) as { error: { code: string } }).error.code]).toEqual([403, "HOLQA_SIGNED_URL_INVALID"]);
  });

  it("rejects tampered, misused and oversized signed requests", async () => {
    const { env, bucket } = await setup();
    await bucket.put("a.txt", encoder.encode("a"), {});
    const download = await bucket.signUrl("a.txt", { method: "GET", expiresInSeconds: 60 });
    const upload = await bucket.signUrl("b.txt", { method: "PUT", expiresInSeconds: 60, contentType: "text/plain" });
    /**
     * Sends a request and returns its status.
     *
     * @param request - The request to serve.
     * @returns The response status.
     */
    const status = async (request: Request): Promise<number> => (await env.storage.fetch(request)).status;
    expect(await status(new Request(download.url.replace("a.txt", "b.txt")))).toBe(403);
    expect(await status(new Request(download.url.replace(/expires=\d+/, "expires=9999999999")))).toBe(403);
    expect(await status(new Request(download.url, { method: "PUT", body: "x" }))).toBe(403);
    expect(await status(new Request(upload.url, { method: "PUT", headers: { "content-type": "text/html" }, body: "x" }))).toBe(403);
    expect(await status(new Request(upload.url, { method: "PUT", headers: { "content-type": "text/plain" }, body: "x".repeat(17) }))).toBe(413);
    // A streamed body without a declared length is cut off at the limit too.
    const stream = new ReadableStream<Uint8Array>({ start: (controller) => {
      for (let chunk = 0; chunk < 4; chunk += 1)
        controller.enqueue(new TextEncoder().encode("xxxxx"));
      controller.close();
    } });
    expect(await status(new Request(upload.url, { method: "PUT", headers: { "content-type": "text/plain" }, body: stream }))).toBe(413);
    expect(await bucket.head("b.txt")).toBeUndefined();
    expect(await status(new Request(download.url, { method: "DELETE" }))).toBe(405);
    expect(await status(new Request("http://local.test/_holqa/storage/files/a.txt"))).toBe(403);
    expect(await status(new Request("http://local.test/_holqa/storage/unknown/a.txt"))).toBe(404);
    expect(await status(new Request("http://local.test/elsewhere"))).toBe(404);
  });

  it("rejects malformed paths, unknown objects and unsigned writes", async () => {
    const { env, bucket } = await setup();
    const assetsDriver = env.binding.drivers.bucket!(assets);
    await assetsDriver.put("logo.svg", encoder.encode("<svg/>"), {});
    /**
     * Sends a request and returns its status and error code.
     *
     * @param request - The request to serve.
     * @returns `<status> <code>`, with the code empty for successful responses.
     */
    const outcome = async (request: Request): Promise<string> => {
      const response = await env.storage.fetch(request);
      return `${response.status} ${response.ok ? "" : ((await response.json()) as { error: { code: string } }).error.code}`.trim();
    };
    const base = "http://local.test/_holqa/storage";
    expect(await outcome(new Request(`${base}/files/%E0%A4%A`))).toBe("400 HOLQA_OBJECT_KEY_INVALID");
    expect(await outcome(new Request(`${base}/files/tab%09key`))).toBe("404 HOLQA_OBJECT_NOT_FOUND");
    const missing = await bucket.signUrl("missing.txt", { method: "GET", expiresInSeconds: 60 });
    expect(await outcome(new Request(missing.url))).toBe("404 HOLQA_OBJECT_NOT_FOUND");
    expect(await outcome(new Request(missing.url, { method: "HEAD" }))).toBe("404 HOLQA_OBJECT_NOT_FOUND");
    expect(await outcome(new Request(`${base}/assets/logo.svg`, { method: "PUT", body: "x" }))).toBe("403 HOLQA_SIGNED_URL_INVALID");
    expect(await outcome(new Request(`${base}/assets/logo.svg?signature=${"0".repeat(64)}`))).toBe("403 HOLQA_SIGNED_URL_INVALID");
    const upload = await bucket.signUrl("new.txt", { method: "PUT", expiresInSeconds: 60 });
    expect(await outcome(new Request(upload.url))).toBe("403 HOLQA_SIGNED_URL_INVALID");
  });

  it("round-trips keys that need encoding through signed URLs", async () => {
    const { env, bucket } = await setup();
    for (const key of ["with space.txt", "percent%25.txt", "ünïcode/ファイル.txt", "a//b"]) {
      await bucket.put(key, encoder.encode(key), {});
      const { url } = await bucket.signUrl(key, { method: "GET", expiresInSeconds: 60 });
      const response = await env.storage.fetch(new Request(url));
      expect([response.status, await response.text()]).toEqual([200, key]);
    }
  });

  it("redrives dead-lettered events of one subscription", async () => {
    const { env, bucket } = await setup();
    const subscription = await env.binding.sources!.bucket!(files).subscribe({ id: "files.created", types: ["object.created"] });
    await bucket.put("a.txt", encoder.encode("a"), {});
    const [delivery] = await subscription.receive({ max: 1, leaseMs: 1_000 });
    await subscription.deadLetter(delivery!.receipt, { code: "HOLQA_HANDLER_FAILED", message: "failed", attempt: 1 });
    expect(env.storage.events("files")[0]?.deliveries).toMatchObject([{ subscription: "files.created", state: "dead", attempts: 1, lastError: { code: "HOLQA_HANDLER_FAILED" } }]);
    expect(env.storage.redriveEvents("files", "files.created")).toBe(1);
    expect(await subscription.receive({ max: 1, leaseMs: 1_000 })).toMatchObject([{ id: delivery!.id, attempt: 1 }]);
  });

  it("serves unsigned reads of public-read buckets only", async () => {
    const { env } = await setup();
    await env.binding.drivers.bucket!(assets).put("logo.svg", encoder.encode("<svg/>"), { contentType: "image/svg+xml" });
    const response = await env.storage.fetch(new Request("http://local.test/_holqa/storage/assets/logo.svg"));
    expect([response.status, await response.text()]).toEqual([200, "<svg/>"]);
    const head = await env.storage.fetch(new Request("http://local.test/_holqa/storage/assets/logo.svg", { method: "HEAD" }));
    expect([head.status, head.headers.get("content-length")]).toEqual([200, "6"]);
  });

  it("keeps signed URLs valid across environments that share a state directory", async () => {
    const { env, bucket, directory, clock } = await setup();
    await bucket.put("a.txt", encoder.encode("a"), {});
    const { url } = await bucket.signUrl("a.txt", { method: "GET", expiresInSeconds: 60 });
    env.close();
    const reopened = await createLocalEnvironment({ app: application([files]), directory, clock, env: {}, storage: { signedUrlBase: "http://local.test/_holqa/storage" } });
    cleanups.push(() => reopened.close());
    expect((await reopened.storage.fetch(new Request(url))).status).toBe(200);
  });
});