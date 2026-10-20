import { resources } from "@/app/infra";

/** Charges performed, standing in for a payment service. */
export const charged: string[] = [];

/**
 * Charges each payment once per payment identifier. Duplicate deliveries,
 * and duplicate messages for the same payment, are acknowledged without
 * charging again. A charge whose attempt fails afterwards would be repeated
 * on retry: real payment services need their own idempotency key, here the
 * payment identifier.
 */
export const chargePayment = resources.payments.consume({
  id: "payments.charge",
  idempotency: { key: ({ message }) => message.paymentId, retentionSeconds: 86_400 },
  handler: async ({ message }) => {
    charged.push(message.paymentId);
  }
});