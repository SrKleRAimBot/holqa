import { resources } from "../../infra";

/** Nightly reconciliation run. */
export default resources.nightly.handle({
  id: "maintenance.nightly-reconcile",
  handler: ({ scheduledTime, log }) => {
    log.info("Reconciling", { scheduledTime });
  }
});