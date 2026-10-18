import { resources } from "@/apps/invalid/infra";

/** Settles payments. */
export default resources.payments.consume({ id: "payments.settle", handler: () => {} });