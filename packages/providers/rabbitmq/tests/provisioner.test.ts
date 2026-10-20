import type {
  AnyBindingProvider,
  AppDescriptor,
  DeliveredHandler,
  PlannedChange,
  ProvisioningContext,
  ResourceDescriptor
} from "@holqa/core";

import {
  credentialRef,
  diagnosticsOf,
  parseResourceId
} from "@holqa/core";
import { MemoryBroker } from "@test/support/memory-broker";

import {
  describe,
  expect,
  it
} from "bun:test";

import { rabbitmq } from "@/provider";

/**
 * Parses a resource identifier for fixtures.
 *
 * @param value - A valid identifier.
 * @returns The branded identifier.
 */
function id(value: string): ResourceDescriptor["id"] {
  return (parseResourceId(value) as { readonly value: ResourceDescriptor["id"] }).value;
}

/** A queue with a dead-letter requirement. */
const orders = { protocol: 1, type: "resource", kind: "queue", id: id("orders"), config: { schemaVersion: 1 }, requirements: { delivery: "at-least-once", deadLetter: true }, schemas: {} } as unknown as ResourceDescriptor;

/** A bucket whose object events arrive through a RabbitMQ event channel. */
const files: ResourceDescriptor = { protocol: 1, type: "resource", kind: "bucket", id: id("files"), config: {}, requirements: { access: "private" }, schemas: {} };

/** The bucket provider, as the provisioner reads it: only its settings matter. */
const storage = { provider: "holqa.s3", name: "s3", settings: { events: { channel: "holqa.rabbitmq.events", channelSettings: { queuePrefix: "holqa.events.", exchange: "store-events", delayedDelivery: "delay-queues", deadLetter: true } } } } as unknown as AnyBindingProvider;

/** The object event handler whose subscription needs a queue. */
const handlers: DeliveredHandler[] = [{ id: "files.scan", trigger: { kind: "bucket.object-created", resource: { kind: "bucket", id: files.id }, options: {} } } as unknown as DeliveredHandler];

/**
 * Builds the provisioning context for the queue and bucket.
 *
 * @param queues - The queue provider.
 * @returns A context with both resources and the scan handler.
 */
function contextOf(queues: AnyBindingProvider): ProvisioningContext {
  return { app: { name: "shop" } as AppDescriptor, environment: "staging", resources: [{ resource: orders, provider: queues }, { resource: files, provider: storage }], handlers, credential: () => "amqp://admin@broker", signal: new AbortController().signal, log: () => {} };
}

/**
 * Summarizes changes as `action type target`.
 *
 * @param changes - Planned changes.
 * @returns One line per change.
 */
function summary(changes: readonly PlannedChange[]): string[] {
  return changes.map(change => `${change.action} ${change.type} ${change.target}`);
}

describe("rabbitmq.provisioner", () => {
  const queues = rabbitmq.queues({ url: credentialRef("QUEUE_URL"), delayedDelivery: "delay-queues", prefix: "shop." }) as unknown as AnyBindingProvider;

  it("claims RabbitMQ queues and buckets with a RabbitMQ event channel, within its scope", () => {
    const provisioner = rabbitmq.provisioner({ url: credentialRef("RABBITMQ_ADMIN_URL") });
    expect([provisioner.supports(queues, orders), provisioner.supports(storage, files), provisioner.supports(storage, orders)]).toEqual([true, true, false]);
    expect(rabbitmq.provisioner({ url: credentialRef("RABBITMQ_ADMIN_URL"), providers: ["other"] }).supports(queues, orders)).toBe(false);
    expect(provisioner.credentials?.map(reference => reference.name)).toEqual(["RABBITMQ_ADMIN_URL"]);
  });

  it("plans the whole topology on an empty broker, applies it, and then plans no changes", async () => {
    const broker = new MemoryBroker();
    const provisioner = rabbitmq.provisioner({ url: credentialRef("RABBITMQ_ADMIN_URL"), transport: (_url, options) => broker.transport(options.binding) });
    const plan = await provisioner.plan(contextOf(queues));
    expect(summary(plan.changes)).toEqual([
      "create rabbitmq.exchange store-events",
      "create rabbitmq.queue shop.orders",
      "create rabbitmq.queue shop.orders.dead-letter",
      ...[1, 2, 5, 10, 30, 60, 120, 300, 600, 900].map(step => `create rabbitmq.queue shop.orders.delay.${step}`),
      "create rabbitmq.queue holqa.events.files.files.scan",
      "create rabbitmq.queue holqa.events.files.files.scan.dead-letter",
      ...[1, 2, 5, 10, 30, 60, 120, 300, 600, 900].map(step => `create rabbitmq.queue holqa.events.files.files.scan.delay.${step}`),
      "create rabbitmq.binding store-events -> holqa.events.files.files.scan"
    ]);
    expect(plan.changes.every(change => !change.destructive)).toBe(true);
    const applied = await provisioner.apply(contextOf(queues), plan.changes.filter(change => change.action !== "none"));
    expect(applied.every(item => item.status === "applied")).toBe(true);
    expect(broker.exchanges.get("store-events")?.bindings).toEqual(new Set(["holqa.events.files.files.scan:"]));
    const again = await provisioner.plan(contextOf(queues));
    expect([...new Set(again.changes.map(change => change.action))]).toEqual(["none", "update"]);
  });

  it("classifies a queue with other arguments as a destructive replacement", async () => {
    const broker = new MemoryBroker();
    broker.declare("shop.orders", { "x-queue-type": "classic" });
    const provisioner = rabbitmq.provisioner({ url: credentialRef("RABBITMQ_ADMIN_URL"), transport: (_url, options) => broker.transport(options.binding) });
    const replaced = (await provisioner.plan(contextOf(queues))).changes.find(change => change.target === "shop.orders")!;
    expect([replaced.action, replaced.destructive]).toEqual(["replace", true]);
    expect(replaced.details).toEqual({ purpose: "messages", arguments: { "x-queue-type": "quorum" } });
  });

  it("rejects invalid settings", () => {
    let codes: string[] = [];
    try {
      rabbitmq.provisioner({ url: "amqp://admin" as never, exchangeType: "headers" as never });
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_BINDING_CONFIG_INVALID", "HOLQA_BINDING_CONFIG_INVALID"]);
  });
});