import { resources } from "@/infra";

/** Runs when an invoice document is stored; a real application would email the customer here. */
export default resources.invoices.onObjectCreated({
  id: "invoices.created",
  prefix: "invoices/",
  handler: ({ object, log }) => {
    log.info("Invoice stored", { key: object.key, size: object.size });
  }
});