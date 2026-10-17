import {
  bucket,
  defineResources
} from "@/index";

/** Catalog resources, declared in their own module and composed into the app. */
export const catalogResources = defineResources({
  images: bucket({ id: "catalog-images", access: "public-read" })
});