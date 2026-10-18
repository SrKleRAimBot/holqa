import { z } from "zod";

/** One order line. */
const orderLine = z.object({
  sku: z.string().regex(/^[A-Z0-9-]+$/),
  quantity: z.int().min(1)
});

/** The order message: producers send an ISO timestamp; consumers receive a `Date`. */
export const orderPlaced = z.object({
  orderId: z.string().min(1),
  priority: z.enum(["normal", "urgent"]).default("normal"),
  lines: z.array(orderLine).min(1),
  placedAt: z.iso.datetime().transform(value => new Date(value))
});