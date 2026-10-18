import { resources } from "@/app/infra";

/**
 * Records every uploaded file. Object events arrive at least once, so the
 * record is written by key and a duplicate event rewrites the same record.
 */
export const recordUpload = resources.uploads.onObjectCreated({
  id: "uploads.received",
  handler: async ({ object, event, log }) => {
    await resources.receipts.put(`uploads/${object.key}.json`, JSON.stringify({ key: object.key, size: object.size, contentType: object.contentType ?? null, eventId: event.id }), { contentType: "application/json" });
    log.info("upload recorded", { key: object.key, size: object.size });
  }
});