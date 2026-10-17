// Illustrative example: uses the proposed Holqa API, which is not implemented yet. This file is not type-checked or executed.
import { SQL } from "bun";
import { z } from "zod";

import {
  config,
  resources
} from "../../infra";

/** Connection pool for this procedure; the connection string never reaches the browser. */
const sql = new SQL(config.DATABASE_URL);

/** Public shape of an order returned to the frontend; internal columns are not exposed. */
const orderSummary = z.object({
  id: z.string().uuid(),
  sku: z.string(),
  quantity: z.number().int(),
  status: z.enum(["pending", "processing", "shipped"])
});

export default resources.api.query({
  id: "orders.list",
  input: z.object({
    limit: z.number().int().min(1).max(100).default(20)
  }),
  output: z.array(orderSummary),
  handler: async ({ input }) => {
    const rows = await sql`SELECT id, sku, quantity, status FROM orders ORDER BY created_at DESC LIMIT ${input.limit}`;
    return rows;
  }
});