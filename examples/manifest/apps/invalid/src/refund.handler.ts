import { refunds } from "@/apps/invalid/src/refunds";

/** Mistake 2: a handler for a queue the application does not declare. */
export default refunds.consume({ id: "refunds.process", handler: () => {} });