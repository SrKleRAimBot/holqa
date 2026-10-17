import { z } from "zod";

import { resources } from "@/infra";
import {
  catalog,
  insertOrder
} from "@/src/store";

/** The request body: the client sends SKUs and quantities, never prices. */
const placeOrderBody = z.object({
  customerEmail: z.email(),
  lines: z.array(z.object({ sku: z.string(), quantity: z.number().int().min(1).max(100) })).min(1),
  express: z.boolean().default(false)
});

/**
 * `POST /api/orders`: prices the order from the catalog, stores it and enqueues
 * fulfillment. The queue message type is inferred from the `order-fulfillment`
 * schema in infra.ts; sending is at-least-once, so the consumer is idempotent.
 */
export default resources.api.route({
  id: "orders.place",
  method: "POST",
  path: "/orders",
  body: placeOrderBody,
  responses: {
    202: z.object({ orderId: z.uuid(), total: z.number() }),
    422: z.object({ message: z.string(), unknownSkus: z.array(z.string()) })
  },
  handler: async ({ body, reply }) => {
    const unknownSkus = body.lines.map(line => line.sku).filter(sku => !catalog.has(sku));
    if (unknownSkus.length > 0)
      return reply(422, { message: "Some products do not exist.", unknownSkus });

    const lines = body.lines.map(line => ({ sku: line.sku, quantity: line.quantity, unitPrice: catalog.get(line.sku)!.price }));
    const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
    const message = {
      orderId: crypto.randomUUID(),
      customerEmail: body.customerEmail,
      lines,
      priority: body.express ? "express" as const : "standard" as const,
      placedAt: new Date().toISOString()
    };

    insertOrder({ orderId: message.orderId, customerEmail: message.customerEmail, status: "pending", total });
    // Validated against the queue schema on send; consumers receive `placedAt` as a Date and branded SKUs.
    await resources.orders.send(message);
    return reply(202, { orderId: message.orderId, total });
  }
});