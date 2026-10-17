import { z } from "zod";

/** A stock-keeping unit code, branded on the output side. Imported by infra.ts from this separate module. */
export const sku = z.string().regex(/^[A-Z0-9-]+$/).brand<"Sku">();

/** One order line. */
export const orderLine = z.object({
  sku,
  quantity: z.number().int().positive()
});

/** The order message: producers send an ISO string for `placedAt`; consumers receive a `Date`. */
export const orderPlaced = z.object({
  orderId: z.string(),
  priority: z.enum(["normal", "urgent"]).default("normal"),
  lines: z.array(orderLine).min(1),
  placedAt: z.iso.datetime().transform(value => new Date(value))
});