import { z } from "zod";

/** A shipment that waits for stock: it is checked again until it ships or gives up. */
export const shipment = z.object({
  orderId: z.string().min(1),
  /** How many times stock was checked so far. */
  checks: z.number().int().min(0)
});

/** A reminder to a customer. */
export const reminder = z.object({
  customerId: z.string().min(1),
  /** How many reminders were sent so far. */
  count: z.number().int().min(0)
});

/** A payment to charge once. */
export const charge = z.object({
  paymentId: z.string().min(1),
  amountCents: z.number().int().positive()
});

/** How many stock checks a shipment gets before it is given up. */
export const maxStockChecks = 5;