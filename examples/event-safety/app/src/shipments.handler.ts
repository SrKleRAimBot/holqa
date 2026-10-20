import { resources } from "@/app/infra";
import { maxStockChecks } from "@/app/src/contracts";

/** Order identifiers whose stock has arrived, standing in for an inventory service. */
export const inStock = new Set<string>();

/**
 * Ships an order when its stock has arrived, and otherwise checks again a
 * minute later. The handler requeues itself on purpose: the cycle is
 * declared with its justification, so analysis reports it as allowed, and
 * `maxDepth` bounds it at run time should the termination condition break.
 */
export const fulfilShipment = resources.shipments.consume({
  id: "shipments.fulfil",
  events: { cycle: { justification: "Each check increments checks; after maxStockChecks the shipment is given up." }, maxDepth: 10 },
  handler: async ({ message, log }) => {
    if (inStock.has(message.orderId)) {
      log.info("shipped", { orderId: message.orderId, checks: message.checks });
      return;
    }
    if (message.checks + 1 >= maxStockChecks) {
      log.warn("shipment given up", { orderId: message.orderId });
      return;
    }
    await resources.shipments.send({ orderId: message.orderId, checks: message.checks + 1 }, { delaySeconds: 60 });
  }
});