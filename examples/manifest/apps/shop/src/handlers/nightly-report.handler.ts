import { resources } from "@/apps/shop/infra";

/** Writes the nightly report. */
export default resources.nightly.handle({
  id: "reports.nightly",
  handler: ({ scheduledTime, log }) => {
    log.info("nightly report", { scheduledTime });
  }
});