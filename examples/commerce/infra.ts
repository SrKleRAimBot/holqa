import {
  bucket,
  defineApp,
  http,
  queue,
  schedule,
  secret,
  variable
} from "@holqa/experiment-sdk";

import { z } from "zod";
import {
  orderPlaced,
  paymentEvent
} from "@/src/contracts";

/**
 * The commerce application's resource graph. Each `id` is a stable logical
 * identity; the property names are local aliases. Nothing here provisions
 * infrastructure or runs business logic.
 */
const app = defineApp({
  name: "commerce",
  handlers: ["./src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "storefront-api", basePath: "/api", docs: { title: "Storefront API", version: "1.0.0" } }),
    orders: queue({ id: "order-fulfillment", message: orderPlaced, schemaVersion: 1, delivery: { maxAttempts: 5, deadLetter: true } }),
    payments: queue({ id: "payment-events", message: paymentEvent, schemaVersion: 1, delivery: { maxAttempts: 8, deadLetter: true } }),
    invoices: bucket({ id: "invoices", access: "private" }),
    reconciliation: schedule({ id: "nightly-reconciliation", cron: "0 3 * * *", timezone: "UTC", overlap: "skip" })
  },
  env: {
    PAYMENT_WEBHOOK_SECRET: secret(z.string().min(16)),
    CURRENCY: variable(z.enum(["EUR", "USD", "GBP"]), { default: "EUR" }),
    LOG_LEVEL: variable(z.enum(["debug", "info", "warn", "error"]), { default: "info" })
  }
});

export default app;

/** Typed resource handles for handler modules. */
export const resources = app.resources;

/** Validated configuration. Read it inside handlers, never at module top level. */
export const config = app.env;