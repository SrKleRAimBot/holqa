import { z } from "zod";

import { resources } from "../../infra";
import { createOrderBody } from "../contracts";

/** Accepts an order and enqueues it for processing. */
export default resources.api.route({
  id: "orders.create",
  method: "POST",
  path: "/orders",
  body: createOrderBody,
  responses: { 202: z.object({ orderId: z.string() }) },
  handler: async ({ body, reply }) => {
    const orderId = `order-${body.items.length}`;
    await resources.orders.send({ orderId, priority: body.priority, items: body.items });
    return reply(202, { orderId });
  }
});