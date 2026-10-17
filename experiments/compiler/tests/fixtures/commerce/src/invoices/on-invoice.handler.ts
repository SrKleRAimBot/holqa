import { resources } from "../../infra";

/** Reacts to uploaded invoices. */
export default resources.invoices.onObjectCreated({
  id: "invoices.received",
  prefix: "incoming/",
  handler: ({ object, log }) => {
    log.info("Invoice received", { key: object.key });
  }
});