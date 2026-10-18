import {
  env,
  resources
} from "@/apps/shop/infra";

/** Consumes order messages. Configuration is read inside the handler, never at module top level. */
export default resources.orders.consume({
  id: "orders.process",
  concurrency: 4,
  handler: ({ message, log }) => {
    log.info("processing order", { orderId: message.orderId, database: env.DATABASE_URL.length > 0 });
  }
});