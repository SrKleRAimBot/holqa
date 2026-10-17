import { resources } from "@/infra";
import { ordersWithStatus } from "@/src/store";

/**
 * Nightly reconciliation. It derives its report from the scheduled time, not
 * the clock, so a delayed or manually triggered run reports on the same day.
 */
export default resources.reconciliation.handle({
  id: "maintenance.reconcile",
  handler: ({ scheduledTime, log }) => {
    const pending = ordersWithStatus("pending");
    log.info("Reconciliation", { day: scheduledTime.slice(0, 10), pendingOrders: pending.length });
  }
});