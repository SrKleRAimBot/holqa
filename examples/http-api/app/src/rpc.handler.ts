import { z } from "zod";
import {
  env,
  resources
} from "@/app/infra";
import {
  order,
  orderId
} from "@/app/src/contracts";
import { authenticate } from "@/app/src/middleware";
import { orderStore } from "@/app/src/store";

/** Counts orders and reports the shop's currency. A query: callable with GET or POST. */
export const countOrders = resources.api.procedure({
  id: "orders.count",
  operation: "query",
  output: z.object({ total: z.number().int(), currency: z.enum(["EUR", "USD"]) }),
  handler: async ({ scope }) => ({ total: (await scope.use(orderStore)).list().length, currency: env.SHOP_CURRENCY })
});

/** Cancels an order. A mutation: POST only, for signed-in users. */
export const cancelOrder = resources.api.procedure({
  id: "orders.cancel",
  operation: "mutation",
  middleware: [authenticate],
  input: z.object({ orderId }),
  output: order.nullable(),
  handler: async ({ input, scope }) => (await scope.use(orderStore)).cancel(input.orderId) ?? null
});