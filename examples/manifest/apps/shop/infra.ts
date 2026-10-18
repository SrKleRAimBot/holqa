import {
  composeResources,
  defineApp,
  defineResources,
  http,
  queue,
  schedule,
  secret,
  variable
} from "@holqa/sdk";
import { z } from "zod";
import { catalogResources } from "@/apps/shop/src/catalog/resources";
import { orderPlaced } from "@/apps/shop/src/contracts/order";

/** Order resources, declared inline. */
const orderResources = defineResources({
  api: http.api({ id: "shop-api", basePath: "/api", docs: { title: "Shop API", version: "1.0.0" } }),
  orders: queue({ id: "order-placed", message: orderPlaced, schemaVersion: 1, delivery: { maxAttempts: 5, deadLetter: true } }),
  nightly: schedule({ id: "nightly-report", cron: "0 3 * * *", timezone: "UTC", overlap: "skip" })
});

/** A shop whose registry is split across modules. */
const app = defineApp({
  name: "shop",
  description: "Example application compiled by holqa inspect and holqa build --manifest.",
  handlers: ["src/handlers/**/*.handler.ts"],
  resources: composeResources(orderResources, catalogResources),
  env: {
    DATABASE_URL: secret(z.string().min(1)),
    LOG_LEVEL: variable(z.enum(["debug", "info", "warn"]), { default: "info" })
  }
});

export default app;

/** Typed handles for handler modules. */
export const resources = app.resources;

/** Typed configuration values, readable only inside a runtime. */
export const env = app.env;