import {
  bucket,
  defineApp,
  http,
  queue,
  schedule,
  variable
} from "@holqa/sdk";
import { z } from "zod";
import { order } from "@/app/src/contracts";

/**
 * An order pipeline: customers place orders over HTTP, a queue hands them to
 * a background processor that writes a receipt, uploaded files are recorded
 * as they arrive, and an hourly schedule removes old uploads. Every resource
 * runs locally under `holqa dev`; nothing here names an infrastructure provider.
 */
const app = defineApp({
  name: "order-pipeline",
  description: "Local development example: HTTP, a queue with retries, object events and a schedule.",
  handlers: ["src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "orders-api", basePath: "/api" }),
    orders: queue({
      id: "orders",
      message: order,
      schemaVersion: 1,
      // Three attempts, 5 s then 10 s apart; exhausted orders are kept for inspection.
      delivery: { maxAttempts: 3, deadLetter: true, backoff: { strategy: "exponential", initialDelaySeconds: 5, maxDelaySeconds: 60 } }
    }),
    receipts: bucket({ id: "receipts", access: "private" }),
    uploads: bucket({ id: "uploads", access: "private" }),
    cleanup: schedule({ id: "cleanup", cron: "0 * * * *", timezone: "UTC", overlap: "skip" })
  },
  env: {
    UPLOAD_RETENTION_HOURS: variable(z.string().regex(/^\d+$/), { default: "24" })
  }
});

export default app;

/** Typed handles for handler modules. */
export const resources = app.resources;

/** Typed configuration values, readable only inside a runtime. */
export const env = app.env;