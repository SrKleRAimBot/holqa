// Illustrative example: uses the proposed Holqa API, which is not implemented yet. This file is not type-checked or executed.
import { z } from "zod";

import { resources } from "../../infra";
import { sql } from "../db";

/** Request body accepted by `POST /api/orders`; validated before the handler runs. */
const createOrderBody = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  priority: z.enum(["normal", "urgent"]).default("normal")
});

export default resources.api.route({
  id: "orders.create",
  method: "POST",
  path: "/orders",
  body: createOrderBody,
  responses: {
    202: z.object({ orderId: z.string().uuid() })
  },
  handler: async ({ body }) => {
    const orderId = crypto.randomUUID();

    await sql`INSERT INTO orders (id, sku, quantity, status) VALUES (${orderId}, ${body.sku}, ${body.quantity}, 'pending')`;

    // The message type is inferred from the queue's schema in infra.ts.
    // Sending is at-least-once: the consumer must tolerate duplicates.
    await resources.orders.send({
      orderId,
      priority: body.priority
    });

    return {
      status: 202,
      body: { orderId }
    };
  }
});