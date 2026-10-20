// The same application in three environments, without changing a handler:
//
// - A: everything local (always runs);
// - B: external infrastructure: RabbitMQ queues, an S3-compatible store whose
//   notifications reach the handlers through RabbitMQ, the container host and
//   scheduler, OTLP telemetry;
// - C: mixed: the local platform for compute and schedules, RabbitMQ and the
//   store for queues and files, OTLP telemetry, secrets from files.
//
// B and C run when HOLQA_RABBITMQ_URL, HOLQA_S3_ENDPOINT, HOLQA_S3_ACCESS_KEY_ID,
// HOLQA_S3_SECRET_ACCESS_KEY and HOLQA_S3_EVENTS_TARGET (the store's AMQP
// notification target, publishing to the broker's "holqa.storage-events"
// exchange) are set, as in CI's provider job. Each run provisions its own
// uniquely prefixed queues and bucket and removes them afterwards.
import type { BindingsDefinition } from "@holqa/bindings";
import type { DeliveredHandler } from "@holqa/core";
import type { CompiledApplication } from "@holqa/runtime-bun";

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  join
} from "node:path";
import {
  applyProvisioning,
  inspectBindings,
  resolveBindings
} from "@holqa/bindings";
import { startContainer } from "@holqa/container";
import { rabbitMqTransport } from "@holqa/rabbitmq";
import {
  loadCompiledApplication,
  silentSink
} from "@holqa/runtime-bun";
import {
  deleteObject,
  listObjects,
  sha256Hex,
  signHeaders
} from "@holqa/s3";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout
} from "bun:test";
import {
  externalBindings,
  localBindings,
  mixedBindings,
  provisioningOf
} from "@/app/environments";
import {
  acceptedUpload,
  documentStatus
} from "@/app/src/contracts";

setDefaultTimeout(90_000);

const { HOLQA_RABBITMQ_URL: rabbitUrl, HOLQA_S3_ENDPOINT: s3Endpoint, HOLQA_S3_ACCESS_KEY_ID: accessKeyId, HOLQA_S3_SECRET_ACCESS_KEY: secretAccessKey, HOLQA_S3_EVENTS_TARGET: eventsTarget } = process.env;
const external = [rabbitUrl, s3Endpoint, accessKeyId, secretAccessKey, eventsTarget].every(value => value !== undefined && value !== "");

const example = join(import.meta.dir, "..");
const bin = join(dirname(Bun.resolveSync("@holqa/cli/package.json", example)), "dist", "bin.js");
const buildDir = mkdtempSync(join(tmpdir(), "holqa-environments-build-"));
let compiled: CompiledApplication;
let handlers: readonly DeliveredHandler[];

/** OTLP requests the receiver got, by path. */
const exported: string[] = [];
const receiver = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    exported.push(new URL(request.url).pathname);
    await request.arrayBuffer();
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }
});

beforeAll(async () => {
  const build = Bun.spawnSync(["bun", bin, "build", "--manifest", "--app", "app/infra.ts", "--out-dir", buildDir], { cwd: example });
  if (build.exitCode !== 0)
    throw new Error(`holqa build failed: ${build.stderr.toString()}`);
  compiled = await loadCompiledApplication({ root: join(example, "app"), buildDir });
  handlers = (JSON.parse(readFileSync(join(buildDir, "manifest.json"), "utf8")) as { readonly handlers: readonly DeliveredHandler[] }).handlers;
});

afterAll(async () => {
  await receiver.stop(true);
  rmSync(buildDir, { recursive: true, force: true });
});

/**
 * Uploads a document through the API and its signed URL, then waits until
 * the background pipeline (object event, queue, processor) reports it processed.
 *
 * @param base - The application's URL.
 * @param text - The document's content.
 * @returns The processed document's status.
 */
async function uploadAndProcess(base: URL, text: string): Promise<ReturnType<typeof documentStatus.parse>> {
  const accepted = await fetch(new URL("/api/documents", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName: "notes.txt", contentType: "text/plain", size: new TextEncoder().encode(text).length }) });
  expect(accepted.status).toBe(201);
  const { documentId, upload } = acceptedUpload.parse(await accepted.json());
  expect((await fetch(upload.url, { method: upload.method, headers: upload.headers, body: text })).status).toBe(200);
  for (let attempt = 0; attempt < 300; attempt++) {
    const status = documentStatus.parse(await (await fetch(new URL(`/api/documents/${documentId}`, base))).json());
    if (status.status === "processed")
      return status;
    await Bun.sleep(100);
  }
  throw new Error(`The document ${documentId} was not processed in time.`);
}

describe("environment A: local", () => {
  it("binds every resource locally, without credentials", () => {
    const report = inspectBindings(resolveBindings(localBindings()), { handlers });
    expect(report.diagnostics).toEqual([]);
    expect([...new Set(report.resources.map(resource => resource.provider))]).toEqual(["local"]);
    expect(report.providers.flatMap(provider => provider.credentials)).toEqual([]);
  });
});

describe.skipIf(!external)("environments B and C: external and mixed infrastructure", () => {
  /**
   * Provisions the configuration's infrastructure, runs the application in a
   * container on it, processes a document end to end, then removes the
   * infrastructure.
   *
   * @param bindings - The binding configuration.
   * @param prefix - The name prefix the configuration uses.
   * @param env - The environment the application starts with.
   * @returns The processed document's status.
   */
  async function runOn(bindings: BindingsDefinition, prefix: string, env: Readonly<Record<string, string>>): Promise<ReturnType<typeof documentStatus.parse>> {
    const admin: Record<string, string> = { RABBITMQ_ADMIN_URL: rabbitUrl!, S3_ADMIN_ACCESS_KEY_ID: accessKeyId!, S3_ADMIN_SECRET_ACCESS_KEY: secretAccessKey! };
    const { plan, result } = await applyProvisioning(provisioningOf(bindings as never, eventsTarget), { handlers, lookup: name => admin[name] });
    expect(result.diagnostics).toEqual([]);
    expect(plan.changes.some(change => change.type === "s3.bucket-notification" && change.action === "create")).toBe(true);
    const running = await startContainer({ app: compiled.app, handlers: compiled.handlers, bindings, env: { PORT: "0", HOST: "127.0.0.1", HOLQA_SHUTDOWN_GRACE_MS: "2000", ...env }, log: silentSink, signals: false, telemetry: { serviceName: "documents" } });
    try {
      const status = await uploadAndProcess(running.url, "first line\nsecond line has words\n");
      // The schedule handler runs on the same bindings; here it is invoked directly instead of waiting for the hourly run.
      const cleanup = await running.runtime.invoke({ handlerId: "uploads.cleanup", metadata: { scheduledTime: new Date().toISOString(), trigger: "manual" } });
      expect(cleanup.ok).toBe(true);
      return status;
    } finally {
      await running.stop();
      const transport = rabbitMqTransport(rabbitUrl!, { binding: "cleanup" });
      await transport.connect(10_000);
      for (const change of plan.changes.filter(item => item.type === "rabbitmq.queue"))
        await transport.remove(change.target);
      await transport.close();
      const connection = { endpoint: new URL(s3Endpoint!), region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! }, binding: "cleanup", timeoutMs: 10_000 };
      const bucket = `${prefix}document-files`;
      for (const object of (await listObjects(connection, bucket, { limit: 1000 })).objects)
        await deleteObject(connection, bucket, object.key);
      const url = new URL(`/${bucket}`, s3Endpoint);
      const { host: _host, ...headers } = signHeaders({ method: "DELETE", url, headers: {}, payloadHash: sha256Hex("") }, connection.credentials, { region: "us-east-1", service: "s3", date: new Date() });
      await fetch(url, { method: "DELETE", headers });
    }
  }

  it("B: runs the handlers in a container on RabbitMQ and the S3-compatible store, exporting telemetry over OTLP", async () => {
    const prefix = `it-${crypto.randomUUID().slice(0, 8)}-`;
    exported.length = 0;
    // The environment configuration service reads the process environment, as a container's would.
    const credentials = { QUEUE_URL: rabbitUrl!, S3_ACCESS_KEY_ID: accessKeyId!, S3_SECRET_ACCESS_KEY: secretAccessKey! };
    Object.assign(process.env, credentials);
    try {
      const status = await runOn(externalBindings({ s3Endpoint: s3Endpoint!, otlpEndpoint: receiver.url.origin, prefix }), prefix, {});
      expect(status.result).toMatchObject({ lines: 3, words: 6 });
      expect(exported).toContain("/v1/traces");
    } finally {
      for (const name of Object.keys(credentials))
        Reflect.deleteProperty(process.env, name);
    }
  });

  it("C: mixes the local platform with RabbitMQ, the store, OTLP and secrets from files", async () => {
    const prefix = `it-${crypto.randomUUID().slice(0, 8)}-`;
    const secrets = mkdtempSync(join(tmpdir(), "holqa-secrets-"));
    const state = mkdtempSync(join(tmpdir(), "holqa-mixed-state-"));
    writeFileSync(join(secrets, "QUEUE_URL"), `${rabbitUrl}\n`);
    writeFileSync(join(secrets, "S3_ACCESS_KEY_ID"), accessKeyId!);
    writeFileSync(join(secrets, "S3_SECRET_ACCESS_KEY"), secretAccessKey!);
    exported.length = 0;
    try {
      const status = await runOn(mixedBindings({ s3Endpoint: s3Endpoint!, otlpEndpoint: receiver.url.origin, prefix, secretsDirectory: secrets, stateDirectory: state }), prefix, {});
      expect(status.result).toMatchObject({ lines: 3, words: 6 });
      expect(exported).toContain("/v1/traces");
    } finally {
      rmSync(secrets, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });
});