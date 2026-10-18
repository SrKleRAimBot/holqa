import type { ObjectEventType } from "@/resources/kinds";

import { diagnosticCodes } from "@/diagnostics/codes";
import { PayloadError } from "@/wire/json-payload";

/** The format tag of version 1 of Holqa's object event envelope. */
export const objectEventFormat = "holqa.object-event/1";

/** Every object event type, in a stable order. */
export const objectEventTypes: readonly ObjectEventType[] = Object.freeze(["object.created", "object.deleted"]);

/** The object an event reports on. Deleted objects carry only their key. */
export interface ObjectEventObject {
  readonly key: string;
  /** Size in bytes; present for `object.created`. */
  readonly size?: number;
  readonly contentType?: string;
  /** The version tag of the object the event reports on, when the binding knows it. */
  readonly etag?: string;
}

/**
 * The portable description of one change to a bucket, independent of any
 * storage service's notification format. Drivers for external services
 * translate their notifications into this envelope; the runtime turns it into
 * a handler's input and metadata.
 *
 * Events are delivered at least once, in no guaranteed order. `id` is the
 * event's identity: every delivery of one change, including duplicates and
 * redeliveries, carries the same `id`. Two writes of the same key are two
 * events with different identities.
 */
export interface ObjectEvent {
  readonly format: typeof objectEventFormat;
  /** The event's identity, unique per bucket and stable across redeliveries. */
  readonly id: string;
  readonly type: ObjectEventType;
  /** The logical identifier of the bucket. */
  readonly bucket: string;
  /** When the change happened (ISO 8601, UTC). */
  readonly time: string;
  readonly object: ObjectEventObject;
}

/** ISO 8601 date-time in UTC with optional fractional seconds, as `Date#toISOString` writes it. */
const isoUtcTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * Checks an untrusted value structurally and returns it as an object event.
 * Unknown properties are dropped, so later additions to the envelope stay
 * readable. Object fields are checked only for their types; a handler's
 * schema validates them again before user code runs.
 *
 * @param value - The received value, for example parsed JSON from a driver's store.
 * @param subject - What is being read, used in error messages.
 * @returns The frozen event.
 * @throws {PayloadError} `HOLQA_PAYLOAD_MALFORMED` naming the offending JSON path.
 */
export function readObjectEvent(value: unknown, subject: string): ObjectEvent {
  if (!isRecord(value))
    throw malformed(subject, "$", "the event must be a JSON object.");
  const { format, id, type, bucket, time, object } = value;
  if (format !== objectEventFormat)
    throw malformed(subject, "$.format", `the event format must be "${objectEventFormat}".`);
  if (typeof id !== "string" || id.length === 0)
    throw malformed(subject, "$.id", "the event identifier must be a non-empty string.");
  if (type !== "object.created" && type !== "object.deleted")
    throw malformed(subject, "$.type", `the event type must be one of ${objectEventTypes.join(", ")}.`);
  if (typeof bucket !== "string" || bucket.length === 0)
    throw malformed(subject, "$.bucket", "the bucket must be a non-empty string.");
  if (typeof time !== "string" || !isoUtcTime.test(time) || Number.isNaN(Date.parse(time)))
    throw malformed(subject, "$.time", "the time must be an ISO 8601 UTC date-time.");
  if (!isRecord(object))
    throw malformed(subject, "$.object", "the object must be a JSON object.");
  const { key, size, contentType, etag } = object;
  if (typeof key !== "string" || key.length === 0)
    throw malformed(subject, "$.object.key", "the key must be a non-empty string.");
  if (size !== undefined && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0))
    throw malformed(subject, "$.object.size", "the size must be a non-negative integer.");
  if (type === "object.created" && size === undefined)
    throw malformed(subject, "$.object.size", "an object.created event must report the size.");
  if (contentType !== undefined && typeof contentType !== "string")
    throw malformed(subject, "$.object.contentType", "the content type must be a string.");
  if (etag !== undefined && typeof etag !== "string")
    throw malformed(subject, "$.object.etag", "the etag must be a string.");
  return Object.freeze({
    format: objectEventFormat,
    id,
    type,
    bucket,
    time,
    object: Object.freeze({
      key,
      ...typeof size === "number" ? { size } : {},
      ...typeof contentType === "string" ? { contentType } : {},
      ...typeof etag === "string" ? { etag } : {}
    })
  });
}

/**
 * Reports whether a value is a non-array object.
 *
 * @param value - Any value.
 * @returns `true` for objects that are neither `null` nor arrays.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Creates the `HOLQA_PAYLOAD_MALFORMED` error for one event path.
 *
 * @param subject - What was being read.
 * @param path - JSON path of the offending field.
 * @param reason - Why the event was rejected.
 * @returns The error to throw.
 */
function malformed(subject: string, path: string, reason: string): PayloadError {
  return new PayloadError(diagnosticCodes.payloadMalformed, subject, path, reason);
}