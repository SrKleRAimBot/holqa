import { z } from "zod";

/** An order as the API returns it. */
export const order = z.object({
  orderId: z.string(),
  sku: z.string(),
  quantity: z.number().int().positive(),
  placedBy: z.string(),
  status: z.enum(["placed", "cancelled"])
});

/** The body of a client error the handlers answer themselves. */
export const problem = z.object({ message: z.string() });

/** An order identifier: `ord_` and digits. */
export const orderId = z.string().regex(/^ord_\d+$/);