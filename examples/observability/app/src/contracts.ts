import { z } from "zod";

/** An order to charge and write a receipt for. */
export const order = z.object({
  orderId: z.string().min(1),
  amountCents: z.number().int().positive()
});