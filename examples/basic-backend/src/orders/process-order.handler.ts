// Illustrative example: uses the proposed Holqa API, which is not implemented yet. This file is not type-checked or executed.
import { resources } from "../../infra";
import { sql } from "../db";

/**
 * The single competing consumer for the `order-processing` queue.
 *
 * Delivery is at-least-once, so the handler is idempotent: it records the
 * order ID in `processed_orders` inside the same transaction as the side
 * effect. A duplicate delivery finds the existing row and does nothing; a
 * failure rolls back both, so the retry starts from a clean state.
 */
export default resources.orders.consume({
  id: "orders.process",
  concurrency: 4,
  handler: async ({ message, delivery, log }) => {
    await sql.begin(async (tx) => {
      const claimed = await tx`
        INSERT INTO processed_orders (order_id) VALUES (${message.orderId})
        ON CONFLICT (order_id) DO NOTHING
        RETURNING order_id`;

      if (claimed.length === 0) {
        log.info("Skipping duplicate delivery", { orderId: message.orderId, attempt: delivery.attempt });
        return;
      }

      await tx`UPDATE orders SET status = 'processing' WHERE id = ${message.orderId}`;
    });

    // Throwing here would schedule a retry; after `maxAttempts` (5) the
    // message moves to the dead-letter queue declared in infra.ts.
  }
});