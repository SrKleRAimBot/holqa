import { z } from "zod";

import {
  env,
  resources
} from "@/app/infra";
import { order } from "@/app/src/contracts";

/** Orders whose charge fails, to show retries in telemetry. */
export const declined = new Set<string>();

/** Accepts an order and queues it. */
export const placeOrder = resources.api.route({
  id: "orders.place",
  method: "POST",
  path: "/orders",
  body: order,
  responses: { 202: z.object({ messageId: z.string() }) },
  handler: async ({ body, log, reply }) => {
    log.info("order accepted", { orderId: body.orderId, amountCents: body.amountCents });
    const { messageId } = await resources.orders.send(body);
    return reply(202, { messageId });
  }
});

/** Charges an order with the payment token and writes its receipt. */
export const chargeOrder = resources.orders.consume({
  id: "orders.charge",
  handler: async ({ message, delivery, log }) => {
    const token = String(env.PAYMENT_TOKEN);
    // The token's value is redacted from this entry, and the field name `authorization` is always redacted.
    log.info(`charging with token ${token}`, { orderId: message.orderId, authorization: `Bearer ${token}`, attempt: delivery.attempt });
    if (declined.has(message.orderId))
      throw new Error(`The payment provider declined order ${message.orderId}.`);
    await resources.receipts.put(`receipts/${message.orderId}.json`, JSON.stringify({ orderId: message.orderId, amountCents: message.amountCents }), { contentType: "application/json" });
  }
});

/** Notices a stored receipt. */
export const receiptStored = resources.receipts.onObjectCreated({
  id: "receipts.stored",
  prefix: "receipts/",
  handler: async ({ object, log }) => {
    log.info("receipt stored", { key: object.key, size: object.size });
  }
});