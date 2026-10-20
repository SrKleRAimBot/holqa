import type {
  HolqaError,
  InputValidationError
} from "@holqa/core";

import {
  bindApp,
  createMessageCodec,
  getAppDescriptor
} from "@holqa/core";
import {
  defineApp,
  queue
} from "@holqa/sdk";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  orderPlacedV1,
  orderPlacedWithCustomer
} from "@/src/orders";

const subject = "message for queue \"order-placed\"";

/**
 * Awaits a promise that must reject and returns the reason.
 *
 * @param promise - The promise expected to reject.
 * @returns The rejection reason.
 */
async function rejectionOf<E>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (error) {
    return error as E;
  }
  throw new Error("Expected the promise to reject.");
}

describe("one schema on publish and on receipt", () => {
  it("validates through a queue handle and a consumer, with input and decoded output types", async () => {
    const orders = queue({ id: "order-placed", message: orderPlacedV1, schemaVersion: 1 });
    const sent: unknown[] = [];
    const app = defineApp({ name: "shop", resources: { orders } });
    const unbind = bindApp(getAppDescriptor(app)!, {
      name: "in-memory",
      capabilities: { queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true } },
      drivers: { queue: () => ({ send: async (envelope) => {
        // Drivers receive the versioned holqa.message/1 envelope and store it unchanged.
        expect(envelope).toMatchObject({ format: "holqa.message/1", schemaVersion: 1 });
        sent.push(envelope.payload);
        return { messageId: `m-${sent.length}` };
      } }) },
      config: () => undefined
    });
    const placedAt: Date[] = [];
    const consumer = orders.consume({ id: "order-placed.fulfil", handler: ({ message }) => {
      expectTypeOf(message.placedAt).toEqualTypeOf<Date>();
      expectTypeOf(message.priority).toEqualTypeOf<"normal" | "urgent">();
      placedAt.push(message.placedAt);
    } });
    try {
      expect(await orders.send({ orderId: "o_1", placedAt: "2026-10-18T09:00:00Z", lines: [{ sku: "SKU-1", quantity: 1 }] })).toEqual({ messageId: "m-1" });
      expect(sent).toEqual([{ orderId: "o_1", placedAt: "2026-10-18T09:00:00Z", lines: [{ sku: "SKU-1", quantity: 1 }] }]);
      await consumer["~holqa"].invoke(sent[0], { invocationId: "i-1", signal: new AbortController().signal, log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }, metadata: { attempt: 1, messageId: "m-1" } });
      expect(placedAt.map(date => date.toISOString())).toEqual(["2026-10-18T09:00:00.000Z"]);
    } finally {
      unbind();
    }
  });

  it("never lets a v1 message reach a v2 consumer silently", async () => {
    const producer = createMessageCodec(orderPlacedV1, { schemaVersion: 1, subject });
    const bytes = await producer.encode({ orderId: "o_1", placedAt: "2026-10-18T09:00:00Z", lines: [{ sku: "SKU-1", quantity: 1 }] });

    const strictConsumer = createMessageCodec(orderPlacedWithCustomer, { schemaVersion: 2, subject });
    expect((await rejectionOf<HolqaError>(strictConsumer.decode(bytes))).code).toBe("HOLQA_PAYLOAD_VERSION_UNSUPPORTED");

    const tolerantConsumer = createMessageCodec(orderPlacedWithCustomer, { schemaVersion: 2, subject, acceptedVersions: [1, 2] });
    const error = await rejectionOf<InputValidationError>(tolerantConsumer.decode(bytes));
    expect(error.code).toBe("HOLQA_INPUT_INVALID");
    expect(error.issues.map(issue => issue.path)).toEqual(["customerId"]);
  });
});