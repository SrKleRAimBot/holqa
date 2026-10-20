// Runs the provisioner against a real RabbitMQ broker when HOLQA_RABBITMQ_URL
// is set (see integration.test.ts). Every case uses unique names and removes
// what it created.
import type {
  AnyBindingProvider,
  AppDescriptor,
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

import { rabbitmq } from "@/provider";
import { rabbitMqTransport } from "@/transport";

const { HOLQA_RABBITMQ_URL: url } = process.env;
const enabled = url !== undefined && url !== "";

describe.skipIf(!enabled)("rabbitmq.provisioner against a real broker", () => {
  it("creates the topology, then plans no change, and detects queues with other arguments", async () => {
    const prefix = `it-${crypto.randomUUID().slice(0, 8)}.`;
    const queues = rabbitmq.queues({ url: credentialRef("QUEUE_URL"), delayedDelivery: "delay-queues", prefix }) as unknown as AnyBindingProvider;
    const resource = { protocol: 1, type: "resource", kind: "queue", id: (parseResourceId("orders") as { readonly value: ResourceDescriptor["id"] }).value, config: { schemaVersion: 1 }, requirements: { delivery: "at-least-once", deadLetter: true }, schemas: {} } as unknown as ResourceDescriptor;
    const context: ProvisioningContext = { app: { name: "shop" } as AppDescriptor, environment: "integration", resources: [{ resource, provider: queues }], handlers: [], credential: () => url!, signal: new AbortController().signal, log: () => {} };
    const provisioner = rabbitmq.provisioner({ url: credentialRef("RABBITMQ_ADMIN_URL") });
    const admin = rabbitMqTransport(url!, { binding: "cleanup" });
    await admin.connect(10_000);
    const plan = await provisioner.plan(context);
    try {
      expect([plan.changes.length, [...new Set(plan.changes.map(change => change.action))]]).toEqual([12, ["create"]]);
      expect([...new Set((await provisioner.apply(context, plan.changes)).map(item => item.status))]).toEqual(["applied"]);
      expect([...new Set((await provisioner.plan(context)).changes.map(change => change.action))]).toEqual(["none"]);
      await admin.remove(`${prefix}orders.dead-letter`);
      await admin.declare(`${prefix}orders.dead-letter`, { "x-queue-type": "classic" });
      const replaced = (await provisioner.plan(context)).changes.filter(change => change.action !== "none");
      expect(replaced.map(change => [change.action, change.target, change.destructive])).toEqual([["replace", `${prefix}orders.dead-letter`, true]]);
    } finally {
      for (const change of plan.changes)
        await admin.remove(change.target);
      await admin.close();
    }
  }, 30_000);
});