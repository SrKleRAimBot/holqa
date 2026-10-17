// Fixture: one module that exports two handlers.
import { z } from "zod";

import { resources } from "../../infra";

/** Order summary returned by the read routes. */
const orderSummary = z.object({ orderId: z.string(), status: z.enum(["pending", "processing", "done"]) });

/** Returns one order. */
export const getOrder = resources.api.route({
  id: "orders.get",
  method: "GET",
  path: "/orders/:orderId",
  responses: { 200: orderSummary, 404: z.object({ message: z.string() }) },
  handler: ({ params, reply }) => reply(200, { orderId: params.orderId, status: "pending" })
});

/** Lists orders. */
export const listOrders = resources.api.route({
  id: "orders.list",
  method: "GET",
  path: "/orders",
  query: z.object({ status: z.enum(["pending", "processing", "done"]).optional() }),
  responses: { 200: z.object({ orders: z.array(orderSummary) }) },
  handler: ({ reply }) => reply(200, { orders: [] })
});