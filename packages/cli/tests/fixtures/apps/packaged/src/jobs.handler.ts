import { worker } from "@test/support/descriptors";

/** Processes jobs; logs each one. */
export const work = worker("jobs.work", "jobs", (message, context) => {
  context.log.info("job processed", { job: String(message) });
});