import { handles } from "@/apps/shop-renamed/infra";

/** The order consumer under a new export name and file. */
export const fulfilOrders = handles.fulfilment.consume({
  id: "orders.process",
  concurrency: 4,
  handler: () => {}
});