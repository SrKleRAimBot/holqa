import {
  bucket,
  defineApp,
  http,
  queue,
  schedule,
  secret,
  variable
} from "@holqa/sdk";
import { z } from "zod";
import { placedOrderMessage } from "@/apps/shop-renamed/src/messages/placed";

/**
 * The shop application after a refactor: every variable, alias, file and
 * export is renamed and declarations are reordered, but every `id` is kept.
 * Its manifest is byte-identical to the original's.
 */
const shopApplication = defineApp({
  name: "shop",
  description: "Example application compiled by holqa inspect and holqa build --manifest.",
  handlers: { include: ["src/**/*.ts"], exclude: ["src/messages/**"] },
  resources: {
    productReindexQueue: queue({ id: "catalog-reindex", message: z.object({ productId: z.string().min(1) }), schemaVersion: 1 }),
    productPhotos: bucket({ id: "catalog-images", access: "public-read" }),
    cron: schedule({ id: "nightly-report", cron: "0 3 * * *", timezone: "UTC", overlap: "skip" }),
    fulfilment: queue({ id: "order-placed", message: placedOrderMessage, schemaVersion: 1, delivery: { deadLetter: true, maxAttempts: 5 } }),
    publicApi: http.api({ id: "shop-api", basePath: "/api", docs: { title: "Shop API", version: "1.0.0" } })
  },
  env: {
    LOG_LEVEL: variable(z.enum(["debug", "info", "warn"]), { default: "info" }),
    DATABASE_URL: secret(z.string().min(1))
  }
});

export default shopApplication;

/** Typed handles under new aliases. */
export const handles = shopApplication.resources;