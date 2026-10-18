import {
  bucket,
  defineResources,
  queue
} from "@holqa/sdk";
import { z } from "zod";

/** Catalog resources, declared in their own module and composed into the application. */
export const catalogResources = defineResources({
  images: bucket({ id: "catalog-images", access: "public-read" }),
  reindex: queue({ id: "catalog-reindex", message: z.object({ productId: z.string().min(1) }), schemaVersion: 1 })
});