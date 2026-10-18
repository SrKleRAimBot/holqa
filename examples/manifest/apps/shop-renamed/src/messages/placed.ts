import { z } from "zod";

/** The same order line under another name. */
const lineItem = z.object({
  sku: z.string().regex(/^[A-Z0-9-]+$/),
  quantity: z.int().min(1)
});

/** The same order contract under another name. */
export const placedOrderMessage = z.object({
  orderId: z.string().min(1),
  priority: z.enum(["normal", "urgent"]).default("normal"),
  lines: z.array(lineItem).min(1),
  placedAt: z.iso.datetime().transform(value => new Date(value))
});