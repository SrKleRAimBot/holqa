import { resources } from "@/apps/invalid/infra";

/** Mistake 1: a copy of the settle handler that kept its identifier. */
export default resources.payments.consume({ id: "payments.settle", handler: () => {} });