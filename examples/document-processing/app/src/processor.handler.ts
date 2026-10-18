import { resources } from "@/app/infra";
import {
  documentResult,
  resultKey
} from "@/app/src/contracts";
import {
  readJson,
  writeJson
} from "@/app/src/json-objects";

/**
 * Processes uploaded documents in the background: reads the upload, counts
 * its lines, words and characters, and writes the result next to it.
 *
 * Delivery is at least once, so processing is idempotent: a result for the
 * same upload version is never computed twice. Throwing requests a retry;
 * after the queue's last attempt the job is dead-lettered. For the demo, a
 * document containing `#fail-once` fails its first attempt and one
 * containing `#poison` fails every attempt.
 */
export const processDocument = resources.jobs.consume({
  id: "documents.process",
  concurrency: 4,
  handler: async ({ message, delivery, log }) => {
    const existing = await readJson(resultKey(message.documentId), documentResult);
    if (existing?.sourceEtag === message.etag) {
      log.info("already processed; skipping duplicate", { documentId: message.documentId, messageId: delivery.messageId });
      return;
    }
    const bytes = await resources.files.get(message.key);
    if (bytes === undefined) {
      log.warn("upload no longer exists; nothing to process", { documentId: message.documentId });
      return;
    }
    const text = new TextDecoder().decode(bytes);
    if (text.includes("#poison") || (text.includes("#fail-once") && delivery.attempt === 1))
      throw new Error(`Processing ${message.documentId} failed on attempt ${delivery.attempt}.`);
    await writeJson(resultKey(message.documentId), {
      documentId: message.documentId,
      lines: text.length === 0 ? 0 : text.split("\n").length,
      words: text.split(/\s+/).filter(word => word !== "").length,
      characters: text.length,
      sourceEtag: message.etag,
      processedAt: new Date().toISOString(),
      attempt: delivery.attempt
    });
    log.info("document processed", { documentId: message.documentId, attempt: delivery.attempt });
  }
});