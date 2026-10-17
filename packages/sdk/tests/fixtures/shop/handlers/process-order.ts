import { resources } from "@test/fixtures/shop/infra";

/** Messages processed by the consumer, recorded for assertions. */
export const processed: Array<{ readonly orderId: string; readonly placedAt: Date; readonly attempt: number }> = [];

/** Consumes order messages; the message type comes from the schema declared in infra.ts. */
export default resources.orders.consume({
  id: "orders.process",
  concurrency: 4,
  handler: ({ message, delivery }) => {
    processed.push({ orderId: message.orderId, placedAt: message.placedAt, attempt: delivery.attempt });
  }
});