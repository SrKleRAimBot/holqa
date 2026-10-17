// Fixture: a schema defined two modules away from infra.ts and imported through an index.
import { z } from "zod";

/** One order line. */
export const lineItem = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive()
});