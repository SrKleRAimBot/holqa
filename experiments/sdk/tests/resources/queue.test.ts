import {
  bindApp,
  errorCode,
  getAppDescriptor,
  getHandlerDescriptor
} from "@holqa/experiment-model";
import {
  createContext,
  createFakeBinding
} from "@test/support/fake-binding";

import {
  describe,
  expect,
  it
} from "bun:test";

import { z } from "zod";
import {
  defineApp,
  queue
} from "@/index";

describe("queue", () => {
  const orders = queue({ id: "orders", schemaVersion: 2, delivery: { maxAttempts: 3, deadLetter: true }, message: z.object({ at: z.iso.datetime().transform(value => new Date(value)) }) });
  const app = defineApp({ name: "q", handlers: [], resources: { orders } });
  const binding = createFakeBinding();
  bindApp(getAppDescriptor(app)!, binding);

  it("records delivery requirements as plain data", () => {
    expect(getHandlerDescriptor(orders)).toBeUndefined();
    expect(orders["~holqa"].config).toEqual({ schemaVersion: 2, maxAttempts: 3, deadLetter: true });
  });

  it("validates on send and puts the encoded input form on the wire", async () => {
    await orders.send({ at: "2026-10-17T00:00:00Z" });
    expect(binding.sent.at(-1)?.message).toEqual({ at: "2026-10-17T00:00:00Z" });
    expect(await orders.send({ at: "yesterday" }).then(() => undefined, (error: unknown) => errorCode(error))).toBe("HOLQA_INPUT_INVALID");
  });

  it("round-trips a transformed field from producer to consumer without serialization", async () => {
    const decoded: Date[] = [];
    const consumer = getHandlerDescriptor(orders.consume({ id: "orders.round-trip", handler: ({ message }) => void decoded.push(message.at) }))!;
    await orders.send({ at: "2026-10-17T00:00:00Z" });
    await consumer.invoke(binding.sent.at(-1)?.message, createContext());
    expect(decoded).toEqual([new Date("2026-10-17T00:00:00Z")]);
  });

  it("validates untrusted input before the consumer runs and maps delivery metadata", async () => {
    const received: unknown[] = [];
    const consumer = orders.consume({ id: "orders.consume", concurrency: 2, handler: ({ message, delivery }) => {
      received.push([message.at.toISOString(), delivery.attempt]);
    } });
    const descriptor = getHandlerDescriptor(consumer)!;
    expect(descriptor.trigger).toEqual({ kind: "queue.message", resource: "orders" });
    expect(descriptor.config).toEqual({ concurrency: 2 });

    await descriptor.invoke({ at: "2026-10-17T00:00:00Z" }, createContext({ attempt: 3, messageId: "m-1" }));
    expect(received).toEqual([["2026-10-17T00:00:00.000Z", 3]]);
    expect(await descriptor.invoke({ at: 5 }, createContext()).then(() => undefined, (error: unknown) => errorCode(error))).toBe("HOLQA_INPUT_INVALID");
    expect(received).toHaveLength(1);
  });
});