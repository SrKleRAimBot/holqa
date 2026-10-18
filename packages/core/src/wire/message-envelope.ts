import type {
  JsonObject,
  JsonValue
} from "@/json";

import { diagnosticCodes } from "@/diagnostics/codes";
import {
  decodeJsonPayload,
  encodeJsonPayload,
  PayloadError
} from "@/wire/json-payload";

/** The format tag of version 1 of Holqa's message envelope. */
export const messageEnvelopeFormat = "holqa.message/1";

/**
 * A message as it travels between a producer and a consumer: the payload in
 * its wire (schema input) form, tagged with the schema version it was produced
 * with. The version is the metadata future migration tooling needs to decide
 * how to upgrade a message written by an older deployment.
 */
export interface MessageEnvelope {
  readonly format: typeof messageEnvelopeFormat;
  /** The `schemaVersion` of the contract the producer validated the payload against. */
  readonly schemaVersion: number;
  /** The schema contract fingerprint the producer was built with, when known. */
  readonly fingerprint?: string;
  readonly payload: JsonValue;
}

/**
 * Encodes an envelope as UTF-8 JSON bytes.
 *
 * @param envelope - The envelope. Its payload must already be wire data (see `toWirePayload`).
 * @param subject - What is being encoded, used in error messages.
 * @returns The encoded bytes.
 * @throws {PayloadError} `HOLQA_PAYLOAD_NOT_SERIALIZABLE` when the payload is not JSON data.
 */
export function encodeMessageEnvelope(envelope: MessageEnvelope, subject: string): Uint8Array {
  return encodeJsonPayload({
    format: envelope.format,
    schemaVersion: envelope.schemaVersion,
    ...(envelope.fingerprint === undefined ? {} : { fingerprint: envelope.fingerprint }),
    payload: envelope.payload
  }, subject);
}

/**
 * Decodes and structurally checks a received envelope. The payload inside is
 * still untrusted and must be validated with the contract's schema. Unknown
 * envelope properties are ignored so that later envelope additions stay readable.
 *
 * @param data - The received bytes or text.
 * @param subject - What is being decoded, used in error messages.
 * @returns The frozen envelope, with the payload still unvalidated.
 * @throws {PayloadError} `HOLQA_PAYLOAD_MALFORMED` for invalid JSON, a missing or unknown format, a missing payload or an invalid schema version.
 */
export function decodeMessageEnvelope(data: Uint8Array | string, subject: string): MessageEnvelope {
  const value = decodeJsonPayload(data, subject);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw malformed(subject, "$", "the message envelope must be a JSON object.");
  const record: { readonly format?: JsonValue; readonly schemaVersion?: JsonValue; readonly fingerprint?: JsonValue; readonly payload?: JsonValue } = value as JsonObject;
  if (record.format !== messageEnvelopeFormat)
    throw malformed(subject, "$.format", `the envelope format must be "${messageEnvelopeFormat}".`);
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1)
    throw malformed(subject, "$.schemaVersion", "the schema version must be a positive integer.");
  const fingerprint = record.fingerprint;
  if (fingerprint !== undefined && typeof fingerprint !== "string")
    throw malformed(subject, "$.fingerprint", "the fingerprint must be a string.");
  if (!("payload" in record) || record.payload === undefined)
    throw malformed(subject, "$.payload", "the envelope has no payload.");
  return Object.freeze({
    format: messageEnvelopeFormat,
    schemaVersion,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    payload: record.payload
  });
}

/**
 * Creates the `HOLQA_PAYLOAD_MALFORMED` error for one envelope path.
 *
 * @param subject - What was being decoded.
 * @param path - JSON path of the offending envelope field.
 * @param reason - Why the envelope was rejected.
 * @returns The error to throw.
 */
function malformed(subject: string, path: string, reason: string): PayloadError {
  return new PayloadError(diagnosticCodes.payloadMalformed, subject, path, reason);
}