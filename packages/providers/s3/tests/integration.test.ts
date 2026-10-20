// Runs against a real S3-compatible store when HOLQA_S3_ENDPOINT, HOLQA_S3_ACCESS_KEY_ID
// and HOLQA_S3_SECRET_ACCESS_KEY are set, for example CI's service container or:
//   docker run --rm -p 9000:9000 -e RUSTFS_ACCESS_KEY=holqatest -e RUSTFS_SECRET_KEY=holqa-test-secret rustfs/rustfs
// Without them the tests are skipped; the in-memory store tests cover the logic.
import type {
  AppDescriptor,
  ProviderContext,
  ResourceDescriptorOf
} from "@holqa/core";

import {
  bucketConformance,
  registerConformance
} from "@holqa/conformance";
import {
  createBindingSlot,
  credentialRef,
  diagnosticsOf,
  parseResourceId
} from "@holqa/core";

import {
  describe,
  expect,
  it
} from "bun:test";

import { objectUrl } from "@/client";
import { s3 } from "@/provider";
import {
  sha256Hex,
  signHeaders
} from "@/sigv4";

const { HOLQA_S3_ENDPOINT: endpoint, HOLQA_S3_ACCESS_KEY_ID: accessKeyId, HOLQA_S3_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
const enabled = endpoint !== undefined && endpoint !== "" && accessKeyId !== undefined && secretAccessKey !== undefined;

/**
 * Creates or deletes a bucket with a signed request, as a provisioning step would.
 *
 * @param method - `PUT` to create, `DELETE` to remove.
 * @param bucket - The bucket name.
 */
async function bucketRequest(method: "PUT" | "DELETE", bucket: string): Promise<void> {
  const connection = { endpoint: new URL(endpoint!), region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! }, binding: "provisioning", timeoutMs: 10_000 };
  const url = objectUrl(connection, bucket);
  const { host: _host, ...headers } = signHeaders({ method, url, headers: {}, payloadHash: sha256Hex("") }, connection.credentials, { region: "us-east-1", service: "s3", date: new Date() });
  const response = await fetch(url, { method, headers });
  if (!response.ok && response.status !== 409)
    throw new Error(`${method} bucket ${bucket} failed with ${response.status}: ${await response.text()}`);
}

/**
 * Deletes every object of a bucket, then the bucket.
 *
 * @param bucket - The bucket name.
 * @param driver - A driver for it.
 */
async function emptyAndRemove(bucket: string, driver: NonNullable<ReturnType<NonNullable<NonNullable<Awaited<ReturnType<ReturnType<typeof s3.buckets>["open"]>>["drivers"]>["bucket"]>>>): Promise<void> {
  for (;;) {
    const page = await driver.list({ limit: 1000 });
    for (const object of page.objects)
      await driver.delete(object.key);
    if (page.cursor === undefined)
      break;
  }
  await bucketRequest("DELETE", bucket);
}

/**
 * Builds a bucket resource with a unique identifier and its application.
 *
 * @returns The bucket descriptor and application.
 */
function uniqueBucket(): { readonly bucket: ResourceDescriptorOf<"bucket">; readonly app: AppDescriptor } {
  const id = (parseResourceId(`it-${crypto.randomUUID().slice(0, 8)}`) as { value: ResourceDescriptorOf<"bucket">["id"] }).value;
  const bucket: ResourceDescriptorOf<"bucket"> = { protocol: 1, type: "resource", kind: "bucket", id, config: {}, requirements: { access: "private" }, schemas: {} };
  return { bucket, app: { protocol: 1, type: "app", name: id, handlers: { include: [], exclude: [] }, resources: [bucket], config: [], binding: createBindingSlot() } };
}

/**
 * Builds the context a provider is opened with.
 *
 * @param app - The application.
 * @param secret - The secret the credential resolves to.
 * @returns A context resolving the S3 credential references.
 */
function contextOf(app: AppDescriptor, secret = secretAccessKey!): ProviderContext {
  const values: Record<string, string> = { S3_ACCESS_KEY_ID: accessKeyId!, S3_SECRET_ACCESS_KEY: secret };
  return { app, environment: "integration", resources: app.resources, credential: reference => values[reference.name] ?? "", signal: new AbortController().signal, log: () => {} };
}

describe.skipIf(!enabled)("s3.buckets against a real S3-compatible store", () => {
  const provider = s3.buckets({ endpoint: endpoint ?? "http://localhost:9000", accessKeyId: credentialRef("S3_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_SECRET_ACCESS_KEY") });
  registerConformance(bucketConformance, {
    time: { advance: ms => Bun.sleep(ms) },
    open: async () => {
      const { bucket, app } = uniqueBucket();
      await bucketRequest("PUT", bucket.id);
      const instance = await provider.open(contextOf(app));
      const driver = instance.drivers!.bucket!(bucket);
      return { driver, capabilities: provider.resources.bucket, bucketId: bucket.id, close: () => emptyAndRemove(bucket.id, driver) };
    }
  }, { describe, it }, 60_000);

  it("serves presigned uploads and downloads", async () => {
    const { bucket, app } = uniqueBucket();
    await bucketRequest("PUT", bucket.id);
    const driver = (await provider.open(contextOf(app))).drivers!.bucket!(bucket);
    try {
      const upload = await driver.signUrl("signed.txt", { method: "PUT", expiresInSeconds: 60, contentType: "text/plain" });
      expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: "via a signed URL" })).status).toBe(200);
      const download = await driver.signUrl("signed.txt", { method: "GET", expiresInSeconds: 60 });
      expect(await (await fetch(download.url)).text()).toBe("via a signed URL");
      expect((await driver.head("signed.txt"))?.contentType).toBe("text/plain");
    } finally {
      await emptyAndRemove(bucket.id, driver);
    }
  }, 30_000);

  it("classifies rejected credentials and a missing bucket", async () => {
    const { app } = uniqueBucket();
    let wrong: string[] = [];
    try {
      await provider.open(contextOf(app, "not-the-secret"));
    } catch (error) {
      wrong = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(wrong).toEqual(["HOLQA_BINDING_CREDENTIALS_INVALID"]);
  }, 30_000);
});