import { resources } from "@test/fixtures/shop/infra";

import { z } from "zod";

/** `POST /api/orders`: validates the body and enqueues an order. */
export const placeOrder = resources.api.route({
  id: "orders.place",
  method: "POST",
  path: "/orders",
  body: z.object({ lines: z.array(z.object({ sku: z.string(), quantity: z.number() })), priority: z.enum(["normal", "urgent"]).optional() }),
  responses: {
    202: z.object({ orderId: z.string() }),
    422: z.object({ message: z.string() })
  },
  handler: async ({ body, reply }) => {
    if (body.lines.length === 0)
      return reply(422, { message: "An order needs at least one line." });
    const orderId = `order-${body.lines.length}`;
    await resources.orders.send({
      orderId,
      lines: body.lines.map(line => ({ sku: line.sku, quantity: line.quantity })),
      placedAt: "2026-10-17T12:00:00Z",
      ...(body.priority === undefined ? {} : { priority: body.priority })
    });
    return reply(202, { orderId });
  }
});

/** `GET /api/orders/:orderId`: path parameters are inferred from the template. */
export const getOrder = resources.api.route({
  id: "orders.get",
  method: "GET",
  path: "/orders/:orderId",
  responses: { 200: z.object({ orderId: z.string(), status: z.enum(["pending", "shipped"]) }) },
  handler: ({ params, reply }) => reply(200, { orderId: params.orderId, status: "pending" })
});