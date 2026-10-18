import { z } from "zod";

/** Line items shared by every version of the order message. */
const line = z.object({
  sku: z.string().min(1),
  quantity: z.int().min(1)
});

/** The ISO timestamp on the wire, decoded to a `Date` for consumers. */
const timestamp = z.codec(z.iso.datetime(), z.date(), {
  decode: text => new Date(text),
  encode: date => date.toISOString()
});

/** Version 1 of the `order-placed` message, as deployed. */
export const orderPlacedV1 = z.object({
  orderId: z.string().min(1),
  placedAt: timestamp,
  priority: z.enum(["normal", "urgent"]).default("normal"),
  lines: z.array(line).min(1)
});

/** Version 1 with properties and enum members declared in a different order. Semantically identical. */
export const orderPlacedV1Reordered = z.object({
  lines: z.array(line).min(1),
  priority: z.enum(["urgent", "normal"]).default("normal"),
  placedAt: timestamp,
  orderId: z.string().min(1)
});

/** A compatible evolution: an optional note. Messages already in the queue stay valid. */
export const orderPlacedV1WithNote = orderPlacedV1.extend({
  note: z.string().max(500).optional()
});

/** An incompatible evolution: a required customer. Messages already in the queue lack it. */
export const orderPlacedWithCustomer = orderPlacedV1.extend({
  customerId: z.string().min(1)
});

/** An incompatible evolution: `urgent` is no longer accepted. */
export const orderPlacedWithoutUrgent = orderPlacedV1.extend({
  priority: z.enum(["normal"]).default("normal")
});

/** A schema that cannot be a wire contract: `placedAt` is a `Date` on the input side. */
export const orderPlacedWithDate = orderPlacedV1.extend({
  placedAt: z.date()
});