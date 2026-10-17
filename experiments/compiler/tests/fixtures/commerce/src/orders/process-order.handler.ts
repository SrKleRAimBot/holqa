import { resources } from "../../infra";

/** The single consumer of the order-processing queue. */
export default resources.orders.consume({
  id: "orders.process",
  concurrency: 4,
  handler: ({ message, log }) => {
    log.info("Processing order", { orderId: message.orderId });
  }
});