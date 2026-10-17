import { resources } from "@/infra";
import {
  claimEvent,
  findOrder,
  setOrderStatus
} from "@/src/store";

/**
 * Applies payment events. Providers deliver events at least once and possibly
 * out of order, so each event is claimed by its identifier before it changes
 * the order.
 */
export default resources.payments.consume({
  id: "payments.apply",
  handler: ({ message, log }) => {
    if (!claimEvent(message.eventId)) {
      log.info("Duplicate payment event ignored", { eventId: message.eventId });
      return;
    }
    const record = findOrder(message.orderId);
    if (record === undefined) {
      // Throwing schedules a redelivery: the order may not be stored yet.
      throw new Error(`Order ${message.orderId} is not known yet.`);
    }
    if (message.status === "failed" || message.amount < record.total) {
      setOrderStatus(message.orderId, "payment-failed");
      return;
    }
    setOrderStatus(message.orderId, "paid");
  }
});