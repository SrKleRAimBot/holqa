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
import { MemoryS3 } from "@test/support/memory-s3";

import {
  describe,
  expect,
  it
} from "bun:test";

import { s3 } from "@/provider";

/** The bucket every test provisions. */
const files = { protocol: 1, type: "resource", kind: "bucket", id: (parseResourceId("files") as { readonly value: ResourceDescriptor["id"] }).value, config: {}, requirements: { access: "private" }, schemas: {} } as unknown as ResourceDescriptor;

/** An object event handler on the bucket. */
const handlers = [{ id: "files.scan", trigger: { kind: "bucket.object-created", resource: { kind: "bucket", id: files.id }, options: {} } }] as unknown as DeliveredHandler[];

/**
 * Builds the provisioning context for one store.
 *
 * @param store - The in-memory store.
 * @returns The context, with the runtime provider configured for events.
 */
function contextOf(store: MemoryS3): ProvisioningContext {
  const provider = s3.buckets({ endpoint: "http://s3.test", prefix: "shop-", accessKeyId: credentialRef("S3_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_SECRET_ACCESS_KEY"), fetch: store.fetch, events: { channel: store.channel() } }) as unknown as AnyBindingProvider;
  const values: Record<string, string> = { S3_ADMIN_ACCESS_KEY_ID: "test-access", S3_ADMIN_SECRET_ACCESS_KEY: "test-secret" };
  return { app: { name: "shop" } as AppDescriptor, environment: "staging", resources: [{ resource: files, provider }], handlers, credential: reference => values[reference.name] ?? "", signal: new AbortController().signal, log: () => {} };
}

describe("s3.provisioner", () => {
  it("creates missing buckets and their notification rule, keeps other rules, and then plans no change", async () => {
    const store = new MemoryS3();
    const provisioner = s3.provisioner({ accessKeyId: credentialRef("S3_ADMIN_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_ADMIN_SECRET_ACCESS_KEY"), notifications: { target: "arn:minio:sqs::primary:amqp" }, fetch: store.fetch });
    const plan = await provisioner.plan(contextOf(store));
    expect(plan.changes.map(change => [change.action, change.type, change.target, change.destructive])).toEqual([["create", "s3.bucket", "shop-files", false], ["create", "s3.bucket-notification", "shop-files", false]]);
    expect((await provisioner.apply(contextOf(store), plan.changes)).map(item => item.status)).toEqual(["applied", "applied"]);
    expect(store.buckets.has("shop-files")).toBe(true);
    expect(store.notifications.get("shop-files")).toContain("<Queue>arn:minio:sqs::primary:amqp</Queue><Event>s3:ObjectCreated:*</Event>");
    expect((await provisioner.plan(contextOf(store))).changes.map(change => change.action)).toEqual(["none", "none"]);

    store.notifications.set("shop-files", "<NotificationConfiguration><QueueConfiguration><Id>audit</Id><Queue>arn:other</Queue><Event>s3:ObjectRemoved:*</Event></QueueConfiguration><QueueConfiguration><Id>holqa</Id><Queue>arn:old</Queue><Event>s3:ObjectCreated:*</Event></QueueConfiguration></NotificationConfiguration>");
    const update = await provisioner.plan(contextOf(store));
    expect(update.changes.map(change => change.action)).toEqual(["none", "update"]);
    await provisioner.apply(contextOf(store), update.changes.filter(change => change.action !== "none"));
    expect(store.notifications.get("shop-files")).toContain("<Id>audit</Id><Queue>arn:other</Queue>");
    expect(store.notifications.get("shop-files")).toContain("<Id>holqa</Id><Queue>arn:minio:sqs::primary:amqp</Queue>");
  });

  it("warns instead of guessing when buckets have event handlers but no notification target is configured", async () => {
    const store = new MemoryS3();
    store.createBucket("shop-files");
    const plan = await s3.provisioner({ accessKeyId: credentialRef("S3_ADMIN_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_ADMIN_SECRET_ACCESS_KEY"), fetch: store.fetch }).plan(contextOf(store));
    expect(plan.changes.map(change => change.action)).toEqual(["none"]);
    expect(plan.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity])).toEqual([["HOLQA_PROVISIONING_CONFIG_INVALID", "warning"]]);
  });
});