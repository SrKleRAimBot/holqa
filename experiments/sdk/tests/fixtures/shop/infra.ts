import { catalogResources } from "@test/fixtures/shop/catalog/resources";

import { orderPlaced } from "@test/fixtures/shop/catalog/schemas";
import { z } from "zod";
import {
  defineApp,
  http,
  queue,
  schedule,
  secret,
  variable
} from "@/index";

/** A small but complete application used by the type-inference tests. */
const app = defineApp({
  name: "shop",
  handlers: ["./handlers/*.ts"],
  resources: {
    api: http.api({ id: "shop-api", basePath: "/api" }),
    orders: queue({ id: "order-placed", message: orderPlaced, schemaVersion: 1, delivery: { maxAttempts: 5, deadLetter: true } }),
    nightly: schedule({ id: "nightly-report", cron: "0 3 * * *", timezone: "UTC", overlap: "skip" }),
    ...catalogResources
  },
  env: {
    DATABASE_URL: secret(z.string().min(1)),
    LOG_LEVEL: variable(z.enum(["debug", "info", "warn"]), { default: "info" }),
    PORT: variable(z.coerce.number().int())
  }
});

export default app;

/** Typed handles imported by handler modules. */
export const resources = app.resources;

/** Typed configuration values. */
export const env = app.env;