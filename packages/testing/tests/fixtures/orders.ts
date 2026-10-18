import {
  bucket,
  defineApp,
  http,
  queue,
  schedule
} from "@holqa/sdk";
import { stringRecord } from "@test/support/schemas";

/** An order reference. */
const orderRef = stringRecord("orderId");

/**
 * A small order pipeline: an HTTP route queues orders, a consumer writes a
 * receipt for each, an object event handler notices receipts, and an hourly
 * schedule removes them.
 */
const app = defineApp({
  name: "orders",
  handlers: [],
  resources: {
    api: http.api({ id: "orders-api", basePath: "/api" }),
    orders: queue({ id: "orders", message: orderRef, schemaVersion: 1, delivery: { maxAttempts: 3, deadLetter: true, backoff: { strategy: "fixed", delaySeconds: 5 } } }),
    receipts: bucket({ id: "receipts", access: "private" }),
    cleanup: schedule({ id: "cleanup", cron: "0 * * * *", timezone: "UTC", overlap: "skip" })
  }
});

export default app;

/** The typed handles. */
export const resources = app.resources;

/** Queues an order. */
export const placeOrder = resources.api.route({
  id: "orders.place",
  method: "POST",
  path: "/orders",
  body: orderRef,
  responses: { 202: stringRecord("messageId") },
  handler: async ({ body, reply }) => {
    const { messageId } = await resources.orders.send({ orderId: body.orderId });
    return reply(202, { messageId });
  }
});

/** Writes one receipt per order; a duplicate delivery finds the receipt and does nothing. */
export const processOrder = resources.orders.consume({
  id: "orders.process",
  handler: async ({ message, delivery, log }) => {
    const key = `receipts/${message.orderId}.json`;
    if (await resources.receipts.head(key) !== undefined) {
      log.info("duplicate order skipped", { messageId: delivery.messageId });
      return;
    }
    await resources.receipts.put(key, JSON.stringify({ orderId: message.orderId, attempt: delivery.attempt }), { contentType: "application/json" });
  }
});

/** Notices new receipts. */
export const receiptWritten = resources.receipts.onObjectCreated({
  id: "receipts.written",
  prefix: "receipts/",
  handler: async ({ object, log }) => {
    log.info("receipt stored", { key: object.key });
  }
});

/** Removes every receipt. */
export const cleanUp = resources.cleanup.handle({
  id: "cleanup.run",
  handler: async () => {
    for (const object of (await resources.receipts.list({ prefix: "receipts/" })).objects)
      await resources.receipts.delete(object.key);
  }
});

/** Every handler of the fixture. */
export const handlers = [placeOrder, processOrder, receiptWritten, cleanUp];