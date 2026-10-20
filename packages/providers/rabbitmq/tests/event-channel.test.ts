import type {
  AppDescriptor,
  ProviderContext
} from "@holqa/core";

import {
  createBindingSlot,
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

import { eventChannel } from "@/event-channel";
import {
  queueTopology,
  topologyDeclarations
} from "@/topology";

/** An application without resources; event channels need only the context. */
const app: AppDescriptor = { protocol: 1, type: "app", name: (parseResourceId("shop") as { value: AppDescriptor["name"] }).value, handlers: { include: [], exclude: [] }, resources: [], config: [], binding: createBindingSlot() };

/** The context a channel is opened with. */
const context: ProviderContext = { app, environment: "test", resources: [], credential: () => "amqp://broker", signal: new AbortController().signal, log: () => {} };

describe("rabbitmq.eventChannel", () => {
  it("delivers raw notifications per subscription and settles them like queue messages", async () => {
    const broker = new MemoryBroker();
    for (const declaration of topologyDeclarations(queueTopology("holqa.events.files.scan", { deadLetter: true, delayQueues: true }), "quorum"))
      broker.declare(declaration.queue, declaration.arguments);
    const channel = eventChannel({ url: credentialRef("EVENTS_URL"), transport: (_url, options) => broker.transport(options.binding) });
    expect(channel.credentials).toEqual([{ type: "credential", name: "EVENTS_URL" }]);
    expect(channel.settings).toEqual({ queuePrefix: "holqa.events.", exchange: "holqa.storage-events", delayedDelivery: "delay-queues", deadLetter: true });
    const opened = await channel.open(context);
    const source = await opened.subscribe("files.scan");
    const notification = new TextEncoder().encode(JSON.stringify({ Records: [{ eventName: "s3:ObjectCreated:Put" }] }));
    await broker.transport("store").publish("holqa.events.files.scan", notification, { messageId: "n-1", headers: {} });
    let [delivery] = await source.receive({ max: 1, leaseMs: 60_000 });
    for (let step = 0; delivery === undefined && step < 20; step++) {
      await broker.clock.advance(10);
      [delivery] = await source.receive({ max: 1, leaseMs: 60_000 });
    }
    expect(new TextDecoder().decode(delivery!.body)).toBe(new TextDecoder().decode(notification));
    expect(delivery!.attempt).toBe(1);
    await source.deadLetter(delivery!.receipt, { code: "HOLQA_HANDLER_FAILED", message: "boom", attempt: 1 });
    expect(broker.messages("holqa.events.files.scan.dead-letter")).toHaveLength(1);
    await opened.stop!({ signal: new AbortController().signal });
  });

  it("refuses a subscription whose queues do not exist", async () => {
    const broker = new MemoryBroker();
    const opened = await eventChannel({ url: credentialRef("EVENTS_URL"), transport: (_url, options) => broker.transport(options.binding) }).open(context);
    let codes: string[] = [];
    try {
      await opened.subscribe("files.scan");
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_BINDING_FAILED"]);
  });
});