import { z } from "zod";

import { lineItem } from "./line-item";

/** The queue message produced when an order is accepted. */
export const orderMessage = z.object({
  orderId: z.string(),
  priority: z.enum(["normal", "urgent"]),
  items: z.array(lineItem).min(1)
});

/** Request body of POST /api/orders. */
export const createOrderBody = z.object({
  items: z.array(lineItem).min(1),
  priority: z.enum(["normal", "urgent"]).default("normal")
});