import { z } from "zod";
import { resources } from "@/app/infra";
import {
  acceptedUpload,
  documentId,
  documentRecord,
  documentResult,
  documentStatus,
  problem,
  recordKey,
  resultKey,
  uploadKey,
  uploadRequest
} from "@/app/src/contracts";
import {
  readJson,
  writeJson
} from "@/app/src/json-objects";

/** How long an upload URL stays valid. */
const uploadUrlSeconds = 15 * 60;

/**
 * Accepts an upload: validates the declared metadata, records the document
 * and returns a signed URL the client uploads the bytes to. The bytes never
 * pass through this handler.
 */
export const acceptUpload = resources.api.route({
  id: "documents.accept",
  method: "POST",
  path: "/documents",
  body: uploadRequest,
  responses: { 201: acceptedUpload },
  handler: async ({ body, log, reply }) => {
    const id = crypto.randomUUID();
    await writeJson(recordKey(id), { documentId: id, fileName: body.fileName, contentType: body.contentType, acceptedAt: new Date().toISOString(), uploadExpired: false });
    const signed = await resources.files.signedUrl(uploadKey(id, body.fileName), { method: "PUT", expiresInSeconds: uploadUrlSeconds, contentType: body.contentType });
    log.info("upload accepted", { documentId: id, size: body.size });
    return reply(201, { documentId: id, upload: { url: signed.url, method: "PUT" as const, headers: { ...signed.headers }, expiresAt: signed.expiresAt } }, { location: `/api/documents/${id}` });
  }
});

/** Reports a document's status and, once processed, its result. */
export const getDocument = resources.api.route({
  id: "documents.get",
  method: "GET",
  path: "/documents/:documentId",
  params: z.object({ documentId }),
  responses: { 200: documentStatus, 404: problem },
  handler: async ({ params, reply }) => {
    const record = await readJson(recordKey(params.documentId), documentRecord);
    if (record === undefined)
      return reply(404, { message: `Document ${params.documentId} does not exist.` });
    const result = await readJson(resultKey(params.documentId), documentResult);
    const uploaded = result !== undefined || await resources.files.head(uploadKey(record.documentId, record.fileName)) !== undefined;
    return reply(200, {
      documentId: record.documentId,
      fileName: record.fileName,
      status: result !== undefined ? "processed" as const : uploaded ? "uploaded" as const : "awaiting-upload" as const,
      uploadExpired: record.uploadExpired,
      ...result === undefined ? {} : { result }
    });
  }
});