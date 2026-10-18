import { z } from "zod";

/** A document identifier, generated when an upload is accepted. */
export const documentId = z.uuid();

/** Upload metadata a client declares before sending the file. */
export const uploadRequest = z.object({
  fileName: z.string().regex(/^[\w.-]{1,100}$/, "Use 1 to 100 letters, digits, dots, dashes and underscores."),
  contentType: z.enum(["text/plain", "text/markdown"]),
  /** The declared size in bytes; at most 1 MiB. */
  size: z.number().int().min(1).max(1_048_576)
});

/** Where and how to upload the file. */
export const acceptedUpload = z.object({
  documentId,
  upload: z.object({
    url: z.url(),
    method: z.literal("PUT"),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime()
  })
});

/**
 * The queue message that asks the processor to handle one uploaded file.
 * Version 1 of the contract.
 */
export const documentJob = z.object({
  documentId,
  key: z.string().min(1),
  /** The upload's version tag, so a reprocessed duplicate can be recognized. */
  etag: z.string().min(1),
  contentType: z.string()
});

/** What processing produces. */
export const documentResult = z.object({
  documentId,
  lines: z.number().int().min(0),
  words: z.number().int().min(0),
  characters: z.number().int().min(0),
  sourceEtag: z.string(),
  processedAt: z.iso.datetime(),
  attempt: z.number().int().positive()
});

/** Everything known about one document. */
export const documentStatus = z.object({
  documentId,
  fileName: z.string(),
  status: z.enum(["awaiting-upload", "uploaded", "processed"]),
  uploadExpired: z.boolean(),
  result: documentResult.optional()
});

/** The stored record of an accepted upload. */
export const documentRecord = z.object({
  documentId,
  fileName: z.string(),
  contentType: z.string(),
  acceptedAt: z.iso.datetime(),
  uploadExpired: z.boolean().default(false)
});

/** An error body. */
export const problem = z.object({ message: z.string() });

/**
 * Where an accepted upload's bytes go. Temporary: the cleanup schedule removes it after the upload TTL.
 *
 * @param id - The document's identifier.
 * @param fileName - The validated file name.
 * @returns The object key.
 */
export function uploadKey(id: string, fileName: string): string {
  return `uploads/${id}/${fileName}`;
}

/**
 * Where a document's record is kept.
 *
 * @param id - The document's identifier.
 * @returns The object key.
 */
export function recordKey(id: string): string {
  return `documents/${id}.json`;
}

/**
 * Where a document's processing result is kept.
 *
 * @param id - The document's identifier.
 * @returns The object key.
 */
export function resultKey(id: string): string {
  return `results/${id}.json`;
}

/**
 * Reads the document identifier from an upload key.
 *
 * @param key - A key under `uploads/`.
 * @returns The identifier, or `undefined` for keys of another shape.
 */
export function documentIdOfUpload(key: string): string | undefined {
  const [prefix, id] = key.split("/");
  return prefix === "uploads" && documentId.safeParse(id).success ? id : undefined;
}