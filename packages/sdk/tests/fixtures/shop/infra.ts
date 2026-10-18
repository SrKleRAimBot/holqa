import { catalogResources } from "@test/fixtures/shop/catalog/resources";
import { orderPlaced } from "@test/fixtures/shop/contracts/order";
import { z } from "zod";

import {
  composeResources,
  defineApp,
  defineResources,
  http,
  queue,
  schedule,
  secret,
  variable
} from "@/index";

/** Order resources, declared inline. */
const orderResources = defineResources({
  api: http.api({ id: "shop-api", basePath: "/api", docs: { title: "Shop API", version: "1.0.0" } }),
  orders: queue({ id: "order-placed", message: orderPlaced, schemaVersion: 1, delivery: { maxAttempts: 5, deadLetter: true } }),
  nightly: schedule({ id: "nightly-report", cron: "0 3 * * *", timezone: "UTC", overlap: "skip" })
});

/** A small application whose registry is split across modules. */
const app = defineApp({
  name: "shop",
  description: "Type-inference fixture.",
  handlers: ["./handlers/*.ts"],
  resources: composeResources(orderResources, catalogResources),
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