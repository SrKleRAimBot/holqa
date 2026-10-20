import { consumer } from "@test/support/descriptors";

/** Consumes the orders queue. */
export default consumer("orders.process", "orders");