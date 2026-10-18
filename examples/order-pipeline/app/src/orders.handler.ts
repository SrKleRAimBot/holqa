import { z } from "zod";
import { resources } from "@/app/infra";
import {
  order,
  orderId,
  problem,
  receipt,
  receiptKey
} from "@/app/src/contracts";

/** Accepts an order and queues it for processing. */
export const placeOrder = resources.api.route({
  id: "orders.place",
  method: "POST",
  path: "/orders",
  body: order,
  responses: { 202: z.object({ orderId, messageId: z.string() }) },
  handler: async ({ body, reply }) => {
    const { messageId } = await resources.orders.send(body);
    return reply(202, { orderId: body.orderId, messageId });
  }
});

/** Returns an order's receipt once it has been processed. */
export const getOrder = resources.api.route({
  id: "orders.get",
  method: "GET",
  path: "/orders/:orderId",
  params: z.object({ orderId }),
  responses: { 200: receipt, 404: problem },
  handler: async ({ params, reply }) => {
    const bytes = await resources.receipts.get(receiptKey(params.orderId));
    return bytes === undefined
      ? reply(404, { message: `Order ${params.orderId} has not been processed.` })
      : reply(200, receipt.parse(JSON.parse(new TextDecoder().decode(bytes))));
  }
});

/**
 * Processes queued orders by writing a receipt. Delivery is at least once,
 * so processing is idempotent: an existing receipt means the order is done.
 * Throwing requests a retry; after the third attempt the order is dead-lettered.
 */
export const processOrder = resources.orders.consume({
  id: "orders.process",
  handler: async ({ message, delivery, log }) => {
    const key = receiptKey(message.orderId);
    if (await resources.receipts.head(key) !== undefined) {
      log.info("order already processed", { orderId: message.orderId, messageId: delivery.messageId });
      return;
    }
    await resources.receipts.put(key, JSON.stringify({ orderId: message.orderId, totalCents: message.totalCents ?? 0, messageId: delivery.messageId, attempt: delivery.attempt }), { contentType: "application/json" });
    log.info("order processed", { orderId: message.orderId });
  }
});