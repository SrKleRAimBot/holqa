import { resources } from "@/app/infra";
import {
  documentIdOfUpload,
  documentRecord,
  recordKey
} from "@/app/src/contracts";
import {
  readJson,
  writeJson
} from "@/app/src/json-objects";

/**
 * Turns every new upload into a processing job. Object events arrive at
 * least once, so the same upload may be reported twice: the job carries the
 * upload's etag, and the processor skips work it has already done.
 */
export const queueUploadedDocument = resources.files.onObjectCreated({
  id: "uploads.queue",
  prefix: "uploads/",
  handler: async ({ object, event, log }) => {
    const id = documentIdOfUpload(object.key);
    if (id === undefined) {
      log.warn("ignoring an object outside the upload layout", { key: object.key });
      return;
    }
    const metadata = await resources.files.head(object.key);
    if (metadata === undefined)
      return; // Deleted before the event arrived; nothing to process.
    const { messageId } = await resources.jobs.send({ documentId: id, key: object.key, etag: metadata.etag, contentType: object.contentType ?? "application/octet-stream" });
    log.info("processing job queued", { documentId: id, eventId: event.id, messageId });
  }
});

/** Records that an expired upload was removed. */
export const recordExpiredUpload = resources.files.onObjectDeleted({
  id: "uploads.expired",
  prefix: "uploads/",
  handler: async ({ object, event, log }) => {
    const id = documentIdOfUpload(object.key);
    const record = id === undefined ? undefined : await readJson(recordKey(id), documentRecord);
    if (record === undefined || record.uploadExpired)
      return; // Unknown document, or a duplicate event.
    await writeJson(recordKey(record.documentId), { ...record, uploadExpired: true });
    log.info("upload removed", { documentId: record.documentId, eventId: event.id });
  }
});