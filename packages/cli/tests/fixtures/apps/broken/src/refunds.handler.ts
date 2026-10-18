import { consumer } from "@test/support/descriptors";

/** Consumes a queue the application does not declare. */
export default consumer(
  "refunds.process",
  "refunds"
);