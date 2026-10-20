// Runs the provisioner against a real S3-compatible store when HOLQA_S3_ENDPOINT,
// HOLQA_S3_ACCESS_KEY_ID and HOLQA_S3_SECRET_ACCESS_KEY are set (see
// integration.test.ts). With HOLQA_S3_EVENTS_TARGET (a notification target the
// store knows, for example arn:rustfs:sqs::primary:amqp) it also configures
// notifications. Each case removes the bucket it created.
import type {
  AnyBindingProvider,
  AppDescriptor,
  DeliveredHandler,
  ProvisioningContext,
  ResourceDescriptor
} from "@holqa/core";

import {
  credentialRef,
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

const { HOLQA_S3_ENDPOINT: endpoint, HOLQA_S3_ACCESS_KEY_ID: accessKeyId, HOLQA_S3_SECRET_ACCESS_KEY: secretAccessKey, HOLQA_S3_EVENTS_TARGET: target } = process.env;
const enabled = endpoint !== undefined && endpoint !== "" && accessKeyId !== undefined && secretAccessKey !== undefined;

/**
 * Deletes an empty bucket, as cleanup.
 *
 * @param bucket - The bucket name.
 */
async function removeBucket(bucket: string): Promise<void> {
  const connection = { endpoint: new URL(endpoint!), region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! }, binding: "cleanup", timeoutMs: 10_000 };
  const url = objectUrl(connection, bucket);
  const { host: _host, ...headers } = signHeaders({ method: "DELETE", url, headers: {}, payloadHash: sha256Hex("") }, connection.credentials, { region: "us-east-1", service: "s3", date: new Date() });
  await fetch(url, { method: "DELETE", headers });
}

describe.skipIf(!enabled)("s3.provisioner against a real S3-compatible store", () => {
  it("creates a bucket and its notification rule, then plans no change", async () => {
    const prefix = `it-${crypto.randomUUID().slice(0, 8)}-`;
    const files = { protocol: 1, type: "resource", kind: "bucket", id: (parseResourceId("files") as { readonly value: ResourceDescriptor["id"] }).value, config: {}, requirements: { access: "private" }, schemas: {} } as unknown as ResourceDescriptor;
    const channel = { channel: "example.events", description: "a test channel", open: async () => ({ subscribe: async () => {
      throw new Error("unused");
    } }) };
    const provider = s3.buckets({ endpoint: endpoint!, prefix, accessKeyId: credentialRef("S3_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_SECRET_ACCESS_KEY"), events: { channel } }) as unknown as AnyBindingProvider;
    const handlers = [{ id: "files.scan", trigger: { kind: "bucket.object-created", resource: { kind: "bucket", id: files.id }, options: {} } }] as unknown as DeliveredHandler[];
    const values: Record<string, string> = { ADMIN_KEY: accessKeyId!, ADMIN_SECRET: secretAccessKey! };
    const context: ProvisioningContext = { app: { name: "shop" } as AppDescriptor, environment: "integration", resources: [{ resource: files, provider }], handlers, credential: reference => values[reference.name] ?? "", signal: new AbortController().signal, log: () => {} };
    const provisioner = s3.provisioner({ accessKeyId: credentialRef("ADMIN_KEY"), secretAccessKey: credentialRef("ADMIN_SECRET"), ...target === undefined || target === "" ? {} : { notifications: { target } } });
    try {
      const plan = await provisioner.plan(context);
      const expected = target === undefined || target === "" ? ["create"] : ["create", "create"];
      expect(plan.changes.map(change => change.action as string)).toEqual(expected);
      expect((await provisioner.apply(context, plan.changes)).map(item => item.status)).toEqual(expected.map(() => "applied"));
      expect((await provisioner.plan(context)).changes.map(change => change.action as string)).toEqual(expected.map(() => "none"));
    } finally {
      await removeBucket(`${prefix}files`);
    }
  }, 30_000);
});