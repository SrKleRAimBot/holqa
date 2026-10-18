import {
  defineApp,
  http,
  variable
} from "@holqa/sdk";
import { z } from "zod";
import { requestContext } from "@/app/src/middleware";

/** A small shop: one HTTP API serving routes and RPC procedures. */
const app = defineApp({
  name: "shop",
  description: "Example application served by @holqa/runtime-bun.",
  handlers: ["src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "shop-api", basePath: "/api", docs: { title: "Shop API", version: "1.0.0" } })
  },
  env: {
    SHOP_CURRENCY: variable(z.enum(["EUR", "USD"]), { default: "EUR" })
  },
  // Application middleware runs first for every route and procedure, and its
  // context is typed in every handler registered through `app.resources`.
  middleware: [requestContext]
});

export default app;

/** Typed handles for handler modules. */
export const resources = app.resources;

/** Typed configuration values, readable only inside a runtime. */
export const env = app.env;