import type { LocalEnvironment } from "@holqa/local";
import type {
  CompiledApplication,
  LogEntry,
  Runtime
} from "@holqa/runtime-bun";

import type { Server } from "bun";
import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  join
} from "node:path";
import { readObjectEvent } from "@holqa/core";
import {
  createLocalEnvironment,
  ManualClock
} from "@holqa/local";
import {
  createRuntime,
  loadCompiledApplication
} from "@holqa/runtime-bun";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout
} from "bun:test";
import {
  acceptedUpload,
  documentStatus
} from "@/app/src/contracts";

// The build runs the CLI's analysis process; allow for slow machines.
setDefaultTimeout(60_000);

/** This example's directory. */
const example = join(import.meta.dir, "..");

/** The built `holqa` binary, through the CLI package's public files. */
const bin = join(dirname(Bun.resolveSync("@holqa/cli/package.json", example)), "dist", "bin.js");

/** Where the build output goes; removed after the run. */
const buildDir = mkdtempSync(join(tmpdir(), "holqa-documents-build-"));

/** The bucket, queue and schedule identifiers declared in `infra.ts`. */
const ids = { bucket: "document-files", queue: "document-jobs", schedule: "upload-cleanup" } as const;

/** The compiled application, loaded once. */
let compiled: CompiledApplication;

/** One running copy of the application, created for each test. */
interface Harness {
  readonly env: LocalEnvironment;
  readonly runtime: Runtime;
  readonly server: Server<undefined>;
  readonly clock: ManualClock;
  readonly logs: LogEntry[];
  readonly state: string;
}

/** The harness of the current test. */
let harness: Harness;

beforeAll(async () => {
  const build = Bun.spawnSync(["bun", bin, "build", "--manifest", "--app", "app/infra.ts", "--out-dir", buildDir], { cwd: example });
  if (build.exitCode !== 0)
    throw new Error(`holqa build failed: ${build.stderr.toString()}`);
  compiled = await loadCompiledApplication({ root: join(example, "app"), buildDir });
});

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const state = mkdtempSync(join(tmpdir(), "holqa-documents-state-"));
  const clock = new ManualClock(Date.parse("2026-10-18T09:30:00.000Z"));
  const logs: LogEntry[] = [];
  /**
   * Routes a request; replaced once the runtime has started.
   *
   * @returns A 503 response while the application is starting.
   */
  let handle: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handle(request) });
  const env = await createLocalEnvironment({ app: compiled.app, directory: state, clock, env: {}, storage: { signedUrlBase: `${server.url.origin}/_holqa/storage` } });
  const runtime = createRuntime({ ...compiled, binding: env.binding, log: entry => logs.push(entry) });
  await runtime.start();
  handle = request => env.storage.handles(request) ? env.storage.fetch(request) : runtime.fetch(request);
  harness = { env, runtime, server, clock, logs, state };
});

afterEach(async () => {
  await harness.server.stop(true);
  await harness.runtime.stop({ graceMs: 1_000 });
  harness.env.close();
  rmSync(harness.state, { recursive: true, force: true });
});

/**
 * Sends a request to the application over HTTP.
 *
 * @param path - The path, for example `/api/documents`.
 * @param init - Request settings.
 * @returns The response.
 */
async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, harness.server.url), init);
}

/**
 * Declares an upload and sends its bytes to the signed URL, as a client would.
 *
 * @param text - The file's content.
 * @param fileName - The name the upload is declared with.
 * @returns The document's identifier.
 * @throws {Error} When the API or the upload rejects the request.
 */
async function upload(text: string, fileName = "notes.txt"): Promise<string> {
  const accepted = await call("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName, contentType: "text/plain", size: new TextEncoder().encode(text).length }) });
  if (accepted.status !== 201)
    throw new Error(`The upload was not accepted: ${accepted.status} ${await accepted.text()}`);
  const { documentId, upload: target } = acceptedUpload.parse(await accepted.json());
  const sent = await fetch(target.url, { method: target.method, headers: target.headers, body: text });
  if (sent.status !== 200)
    throw new Error(`The upload failed: ${sent.status} ${await sent.text()}`);
  return documentId;
}

/**
 * Reads a document's status through the API.
 *
 * @param documentId - The identifier the upload was accepted with.
 * @returns The validated status.
 */
async function status(documentId: string): Promise<ReturnType<typeof documentStatus.parse>> {
  return documentStatus.parse(await (await call(`/api/documents/${documentId}`)).json());
}

describe("document processing on the local binding", () => {
  it("accepts an upload, stores it through a signed URL, and processes it in the background", async () => {
    const accepted = await call("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName: "notes.txt", contentType: "text/plain", size: 23 }) });
    expect(accepted.status).toBe(201);
    const { documentId, upload: target } = acceptedUpload.parse(await accepted.json());
    expect(target.headers).toEqual({ "content-type": "text/plain" });
    expect((await status(documentId)).status).toBe("awaiting-upload");

    const sent = await fetch(target.url, { method: "PUT", headers: target.headers, body: "hello local world\nbye" });
    expect(sent.status).toBe(200);
    await harness.env.settle();

    expect(await status(documentId)).toMatchObject({ documentId, status: "processed", uploadExpired: false, result: { documentId, lines: 2, words: 4, characters: 21, attempt: 1 } });
    // The storage event is a portable holqa.object-event/1 envelope, delivered to the subscribed handler.
    const uploadEvents = harness.env.storage.events(ids.bucket).filter(({ event }) => event.object.key.startsWith("uploads/"));
    expect(uploadEvents).toHaveLength(1);
    expect(readObjectEvent(uploadEvents[0]!.event, "event")).toEqual(uploadEvents[0]!.event);
    expect(uploadEvents[0]).toMatchObject({ event: { type: "object.created", bucket: ids.bucket, object: { key: `uploads/${documentId}/notes.txt`, size: 21, contentType: "text/plain" } }, deliveries: [{ subscription: "uploads.queue", state: "acknowledged", attempts: 1 }] });
    // The queue message is a validated, versioned job.
    expect(harness.env.queues.messages(ids.queue)).toMatchObject([{ state: "acknowledged", attempts: 1, schemaVersion: 1, payload: { documentId, key: `uploads/${documentId}/notes.txt`, contentType: "text/plain" } }]);
    // Every step ran through the runtime's dispatcher and was logged with its trigger.
    expect(harness.logs.filter(entry => entry.message === "invocation completed").map(({ handlerId }) => handlerId)).toEqual(expect.arrayContaining(["documents.accept", "uploads.queue", "documents.process"]));
  });

  it("rejects invalid upload metadata and misused upload URLs", async () => {
    const invalid = await call("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName: "../escape.txt", contentType: "application/pdf", size: 10_000_000 }) });
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as { error: { code: string; issues: Array<{ path: string }> } };
    expect(body.error.code).toBe("HOLQA_INPUT_INVALID");
    expect(body.error.issues.map(issue => issue.path).sort()).toEqual(["contentType", "fileName", "size"]);

    const accepted = acceptedUpload.parse(await (await call("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName: "a.txt", contentType: "text/plain", size: 1 }) })).json());
    const wrongType = await fetch(accepted.upload.url, { method: "PUT", headers: { "content-type": "text/html" }, body: "x" });
    expect(wrongType.status).toBe(403);
    harness.clock.advance(15 * 60_000);
    const expired = await fetch(accepted.upload.url, { method: "PUT", headers: accepted.upload.headers, body: "x" });
    expect([expired.status, ((await expired.json()) as { error: { code: string } }).error.code]).toEqual([403, "HOLQA_SIGNED_URL_INVALID"]);
  });

  it("retries a failed processing step after the queue's backoff", async () => {
    const documentId = await upload("#fail-once then fine");
    await harness.env.settle();
    expect((await status(documentId)).status).toBe("uploaded");
    expect(harness.env.queues.messages(ids.queue)).toMatchObject([{ state: "delayed", attempts: 1, lastError: { code: "HOLQA_HANDLER_FAILED" } }]);
    harness.clock.advance(2_000);
    await harness.env.settle();
    expect(await status(documentId)).toMatchObject({ status: "processed", result: { attempt: 2 } });
  });

  it("dead-letters a job whose retries are exhausted, so it can be inspected and redriven", async () => {
    const documentId = await upload("#poison");
    await harness.env.settle();
    harness.clock.advance(2_000);
    await harness.env.settle();
    harness.clock.advance(4_000);
    await harness.env.settle();
    const [dead] = harness.env.queues.deadLetters(ids.queue);
    expect(dead).toMatchObject({ state: "dead-lettered", attempts: 3, payload: { documentId }, lastError: { code: "HOLQA_HANDLER_FAILED" } });
    expect((await status(documentId)).status).toBe("uploaded");
    // The failure is in the logs with the invocation identifier the dead letter records.
    expect(harness.logs.some(({ message, invocationId }) => message === "invocation failed" && invocationId === dead!.lastError?.invocationId)).toBe(true);
    // Redriving runs it again with a fresh attempt count; it still fails, and is dead-lettered again after three attempts.
    expect(harness.env.queues.redrive(ids.queue, dead!.messageId)).toBe(1);
    await harness.env.settle();
    expect(harness.env.queues.messages(ids.queue)).toMatchObject([{ state: "delayed", attempts: 1 }]);
  });

  it("processes a duplicated storage event only once", async () => {
    const documentId = await upload("one two three");
    await harness.env.settle();
    const before = await status(documentId);
    const created = harness.env.storage.events(ids.bucket).find(({ event }) => event.object.key.startsWith("uploads/"));
    expect(harness.env.storage.duplicateEvent(ids.bucket, "uploads.queue", created!.event.id)).toBe(true);
    await harness.env.settle();
    // A second job was queued for the duplicate event, and the processor recognized the upload version.
    expect(harness.env.queues.messages(ids.queue, ["acknowledged"])).toHaveLength(2);
    expect(await status(documentId)).toEqual(before);
    expect(harness.logs.some(entry => entry.message === "already processed; skipping duplicate")).toBe(true);
  });

  it("removes expired uploads on schedule and keeps the results", async () => {
    const documentId = await upload("keep my result");
    await harness.env.settle();
    expect(harness.env.scheduler.nextRun(ids.schedule)).toBe("2026-10-18T10:00:00.000Z");
    // Hourly runs until the upload is older than the 24-hour TTL.
    for (let hour = 0; hour < 25; hour += 1) {
      harness.clock.advance(3_600_000);
      await harness.env.settle();
    }
    const runs = harness.env.scheduler.runs(ids.schedule);
    expect(runs).toHaveLength(25);
    expect(runs.every(run => run.status === "succeeded" && run.trigger === "cron")).toBe(true);
    expect(await status(documentId)).toMatchObject({ status: "processed", uploadExpired: true, result: { words: 3 } });
    expect(harness.env.storage.events(ids.bucket).filter(({ event }) => event.type === "object.deleted").map(({ event, deliveries }) => [event.object.key, deliveries.map(delivery => delivery.state)])).toEqual([
      [`uploads/${documentId}/notes.txt`, ["acknowledged"]]
    ]);
    // A manual run goes through the same path and is recorded too.
    expect(await harness.env.scheduler.trigger(ids.schedule)).toMatchObject({ trigger: "manual", status: "succeeded" });
  });
});