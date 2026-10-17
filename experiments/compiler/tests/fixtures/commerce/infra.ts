// Fixture application for the deterministic compilation experiment.
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

import { orderMessage } from "./src/contracts";

/** The fixture application: an API, a queue with an imported schema, a bucket, a schedule and configuration. */
const app = defineApp({
  name: "fixture-commerce",
  handlers: ["./src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "public-api", basePath: "/api", docs: { title: "Fixture API", version: "1.0.0" } }),
    orders: queue({ id: "order-processing", message: orderMessage, schemaVersion: 1, delivery: { maxAttempts: 5, deadLetter: true } }),
    invoices: bucket({ id: "invoices", access: "private" }),
    nightly: schedule({ id: "nightly-reconcile", cron: "0 3 * * *", timezone: "UTC", overlap: "skip" })
  },
  env: {
    DATABASE_URL: secret(z.string().min(1)),
    LOG_LEVEL: variable(z.enum(["debug", "info", "warn", "error"]), { default: "info" })
  }
});

export default app;

/** Typed resource handles for handler modules. */
export const resources = app.resources;