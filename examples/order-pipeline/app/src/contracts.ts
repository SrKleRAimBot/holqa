import { z } from "zod";

/** An order identifier. */
export const orderId = z.string().regex(/^[\w-]{1,64}$/, "Use 1 to 64 letters, digits, dashes and underscores.");

/** The queue message: one order to process. Version 1 of the contract. */
export const order = z.object({
  orderId,
  /** The total in cents; absent for orders imported without one. */
  totalCents: z.number().int().min(0).optional()
});

/** What processing an order produces. */
export const receipt = z.object({
  orderId,
  totalCents: z.number().int().min(0),
  /** The message the receipt was written for, so a duplicate delivery can be recognized. */
  messageId: z.string(),
  attempt: z.number().int().positive()
});

/** An error body. */
export const problem = z.object({ message: z.string() });

/**
 * Where an order's receipt is stored.
 *
 * @param id - The order's identifier.
 * @returns The object key.
 */
export function receiptKey(id: string): string {
  return `receipts/${id}.json`;
}