import { z } from "zod";

import {
  bucket,
  defineResources,
  queue
} from "@/index";

/** Catalog resources, declared in their own module and composed into the application. */
export const catalogResources = defineResources({
  images: bucket({ id: "catalog-images", access: "public-read" }),
  reindex: queue({ id: "catalog-reindex", message: z.object({ productId: z.string() }), schemaVersion: 1 })
});