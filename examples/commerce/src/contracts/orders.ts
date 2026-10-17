import { z } from "zod";

/** A product code such as `MUG-001`. Branded so that arbitrary strings are not mistaken for SKUs after validation. */
export const sku = z.string().regex(/^[A-Z]+-\d{3}$/).brand<"Sku">();

/** A monetary amount in minor units (cents) of the application's currency. */
export const amount = z.number().int().nonnegative();

/** One line of an order. */
export const orderLine = z.object({
  sku,
  quantity: z.number().int().min(1).max(100),
  unitPrice: amount
});

/**
 * Version 1 of the `order-fulfillment` message. Producers send `placedAt` as an
 * ISO 8601 string; consumers receive a `Date`. Messages from earlier
 * deployments may still be queued, so changes must stay compatible or bump
 * `schemaVersion`.
 */
export const orderPlaced = z.object({
  orderId: z.uuid(),
  customerEmail: z.email(),
  lines: z.array(orderLine).min(1),
  priority: z.enum(["standard", "express"]).default("standard"),
  placedAt: z.iso.datetime().transform(value => new Date(value))
});

/** A payment provider event after its signature has been verified. Provider-neutral by design. */
export const paymentEvent = z.object({
  eventId: z.string().min(1),
  orderId: z.uuid(),
  status: z.enum(["succeeded", "failed"]),
  amount
});