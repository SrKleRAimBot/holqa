// Illustrative example: uses the proposed Holqa API, which is not implemented yet. This file is not type-checked or executed.
import { SQL } from "bun";
import { z } from "zod";

import {
  config,
  resources
} from "../../infra";

/** Connection pool for this procedure; the connection string never reaches the browser. */
const sql = new SQL(config.DATABASE_URL);

export default resources.api.mutation({
  id: "orders.create",
  input: z.object({
    sku: z.string().min(1),
    quantity: z.number().int().positive(),
    // Supplied by the client so that a retried request does not create a second order.
    idempotencyKey: z.string().uuid()
  }),
  output: z.object({ orderId: z.string().uuid() }),
  handler: async ({ input }) => {
    const [row] = await sql`
      INSERT INTO orders (id, sku, quantity, status, idempotency_key)
      VALUES (${crypto.randomUUID()}, ${input.sku}, ${input.quantity}, 'pending', ${input.idempotencyKey})
      ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
      RETURNING id`;
    return { orderId: row.id };
  }
});