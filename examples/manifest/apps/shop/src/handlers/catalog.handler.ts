import { resources } from "@/apps/shop/infra";

/** Creates thumbnails for uploaded catalog images. */
export const thumbnails = resources.images.onObjectCreated({
  id: "catalog.thumbnail",
  prefix: "uploads/",
  handler: async ({ object }) => {
    await resources.reindex.send({ productId: object.key });
  }
});

/** Rebuilds the search index entry of one product. */
export const reindex = resources.reindex.consume({
  id: "catalog.reindex",
  handler: () => {}
});