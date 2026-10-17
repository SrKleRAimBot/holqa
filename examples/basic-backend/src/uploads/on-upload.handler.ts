// Illustrative example: uses the proposed Holqa API, which is not implemented yet. This file is not type-checked or executed.
import { resources } from "../../infra";
import { sql } from "../db";

/** Largest upload, in bytes, that the application accepts for processing. */
const maxUploadBytes = 25 * 1024 * 1024;

/** Content types the application knows how to process. */
const allowedContentTypes = new Set(["image/png", "image/jpeg", "application/pdf"]);

/**
 * Runs when an object is created under `incoming/` in the private
 * `customer-uploads` bucket. Object metadata comes from an untrusted client
 * upload, so it is checked before anything else happens. Storage events are
 * also delivered at least once; the upsert keeps the handler idempotent.
 */
export default resources.uploads.onObjectCreated({
  id: "uploads.register",
  prefix: "incoming/",
  handler: async ({ object, log }) => {
    const accepted = object.size <= maxUploadBytes && allowedContentTypes.has(object.contentType ?? "");
    const status = accepted ? "accepted" : "rejected";

    await sql`
      INSERT INTO uploads (object_key, size, status) VALUES (${object.key}, ${object.size}, ${status})
      ON CONFLICT (object_key) DO UPDATE SET size = EXCLUDED.size, status = EXCLUDED.status`;

    if (!accepted)
      log.warn("Rejected upload", { key: object.key, size: object.size, contentType: object.contentType });
  }
});