import { resources } from "@/infra";
import {
  findOrder,
  setOrderStatus
} from "@/src/store";

/**
 * The single consumer of `order-fulfillment`. It writes an invoice document to
 * the private `invoices` bucket. Writing the same key twice is harmless, so a
 * duplicate delivery produces the same result.
 */
export default resources.orders.consume({
  id: "orders.fulfil",
  concurrency: 4,
  handler: async ({ message, delivery, log }) => {
    const invoice = {
      orderId: message.orderId,
      customerEmail: message.customerEmail,
      issuedFor: message.placedAt.toISOString(),
      lines: message.lines,
      total: message.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)
    };
    await resources.invoices.put(`invoices/${message.orderId}.json`, JSON.stringify(invoice), { contentType: "application/json" });
    if (findOrder(message.orderId)?.status === "paid")
      setOrderStatus(message.orderId, "fulfilled");
    log.info("Invoice written", { orderId: message.orderId, attempt: delivery.attempt, priority: message.priority });
  }
});