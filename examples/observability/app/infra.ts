import {
  bucket,
  defineApp,
  http,
  queue,
  secret
} from "@holqa/sdk";
import { z } from "zod";

import { order } from "@/app/src/contracts";

/**
 * The acceptance scenario of Holqa's observability: an HTTP request places
 * an order, a queue consumer charges it (with a secret token that must never
 * reach logs or telemetry) and writes a receipt, and an object event handler
 * notices the receipt.
 */
const app = defineApp({
  name: "observability",
  description: "Observability example: correlated logs, traces and metrics.",
  handlers: ["src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "shop-api", basePath: "/api" }),
    orders: queue({ id: "orders", message: order, schemaVersion: 1, delivery: { maxAttempts: 3, deadLetter: true, backoff: { strategy: "fixed", delaySeconds: 1 } } }),
    receipts: bucket({ id: "receipts", access: "private" })
  },
  env: {
    PAYMENT_TOKEN: secret(z.string().min(8))
  }
});

export default app;

/** Typed handles for handler modules. */
export const resources = app.resources;

/** Validated configuration for handler modules. */
export const env = app.env;