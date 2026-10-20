import { resources } from "@/app/infra";

/**
 * Writes a thumbnail for every upload. The handler only receives keys under
 * `uploads/` and writes under `thumbnails/`, so analysis can tell that its
 * own writes never trigger it.
 */
export const makeThumbnail = resources.images.onObjectCreated({
  id: "images.thumbnail",
  prefix: "uploads/",
  handler: async ({ object }) => {
    const bytes = await resources.images.get(object.key);
    if (bytes !== undefined)
      await resources.images.put(`thumbnails/${object.key.slice("uploads/".length)}`, bytes, { contentType: object.contentType ?? "application/octet-stream" });
  }
});