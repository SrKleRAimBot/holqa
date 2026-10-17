import { z } from "zod";

import { resources } from "@/infra";
import { findOrder } from "@/src/store";

/** `GET /api/orders/:orderId`: the path parameter is validated as a UUID. */
export default resources.api.route({
  id: "orders.get",
  method: "GET",
  path: "/orders/:orderId",
  params: z.object({ orderId: z.uuid() }),
  responses: {
    200: z.object({ orderId: z.string(), status: z.enum(["pending", "paid", "fulfilled", "payment-failed"]), total: z.number() }),
    404: z.object({ message: z.string() })
  },
  handler: ({ params, reply }) => {
    const record = findOrder(params.orderId);
    return record === undefined
      ? reply(404, { message: `Order ${params.orderId} does not exist.` })
      : reply(200, { orderId: params.orderId, status: record.status, total: record.total });
  }
});