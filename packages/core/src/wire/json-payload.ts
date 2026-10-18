import type { DiagnosticCode } from "@/diagnostics/codes";
import type {
  JsonObject,
  JsonValue
} from "@/json";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";
import { HolqaError } from "@/errors/holqa-error";

/**
 * Thrown when a value cannot be encoded as a wire payload
 * (`HOLQA_PAYLOAD_NOT_SERIALIZABLE`) or received bytes cannot be decoded
 * (`HOLQA_PAYLOAD_MALFORMED`, `HOLQA_PAYLOAD_VERSION_UNSUPPORTED`).
 */
export class PayloadError extends HolqaError {
  /** JSON path of the offending value, for example `$.lines[0].createdAt`; `$` for the whole payload. */
  readonly path: string;

  /**
   * Creates an error with one diagnostic whose `details` carry the subject and the path.
   *
   * @param code - The payload diagnostic code.
   * @param subject - What was encoded or decoded, for example `message for queue "orders"`.
   * @param path - JSON path of the offending value.
   * @param reason - Why the value was rejected. Never includes the value itself.
   * @param hint - Optional guidance.
   */
  constructor(code: DiagnosticCode, subject: string, path: string, reason: string, hint?: string) {
    super(createDiagnostic({
      code,
      severity: "error",
      message: `Cannot ${code === diagnosticCodes.payloadNotSerializable ? "encode" : "decode"} ${subject}: ${path === "$" ? "" : `${path}: `}${reason}`,
      ...(hint === undefined ? {} : { hint }),
      details: { subject, path }
    }));
    this.name = "PayloadError";
    this.path = path;
  }
}

/** The media type of Holqa's JSON wire payloads. */
export const jsonPayloadMediaType = "application/json";

/**
 * Converts a value to the exact JSON data that crosses an execution boundary,
 * or rejects it. The result is a fresh copy, so later changes to `value`
 * cannot alter what was sent.
 *
 * Encoding rules:
 * - `null`, booleans, strings, finite numbers, arrays and plain objects are kept. `-0` becomes `0`.
 * - Object properties whose value is `undefined` are omitted, as in JSON. Validate
 *   the returned value (not the original) so the schema sees what is transmitted.
 * - Everything else is rejected with its path: `undefined` array entries and
 *   holes, `NaN`, `Infinity`, `bigint`, symbols, functions, symbol keys,
 *   cycles, and non-plain objects such as `Date`, `Map`, `Set`, `Uint8Array`
 *   and class instances. Binary data travels through a bytes codec or a bucket, never inside JSON.
 *
 * @param value - The value to encode, typically a schema's input value.
 * @param subject - What is being encoded, used in error messages.
 * @returns A JSON copy of the value.
 * @throws {PayloadError} `HOLQA_PAYLOAD_NOT_SERIALIZABLE` naming the first offending path.
 */
export function toWirePayload(value: unknown, subject: string): JsonValue {
  return copyJson(value, "$", subject, new Set());
}

/**
 * Encodes a value as UTF-8 JSON bytes after applying {@link toWirePayload}.
 *
 * @param value - The value to encode.
 * @param subject - What is being encoded, used in error messages.
 * @returns The UTF-8 encoded JSON text.
 * @throws {PayloadError} `HOLQA_PAYLOAD_NOT_SERIALIZABLE` when the value has no JSON form.
 */
export function encodeJsonPayload(value: unknown, subject: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(toWirePayload(value, subject)));
}

/**
 * Decodes UTF-8 JSON bytes (or JSON text) received from another execution
 * context. The result is untrusted: validate it with the contract's schema.
 *
 * @param data - The received bytes or text.
 * @param subject - What is being decoded, used in error messages.
 * @returns The parsed JSON value.
 * @throws {PayloadError} `HOLQA_PAYLOAD_MALFORMED` for invalid UTF-8 or invalid JSON.
 */
export function decodeJsonPayload(data: Uint8Array | string, subject: string): JsonValue {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new PayloadError(diagnosticCodes.payloadMalformed, subject, "$", "the payload is not valid UTF-8.");
    }
  }
  try {
    // JSON.parse only produces JSON values, and keeps "__proto__" as an own property.
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new PayloadError(diagnosticCodes.payloadMalformed, subject, "$", "the payload is not valid JSON.");
  }
}

/**
 * Copies one value for {@link toWirePayload}, rejecting anything without an exact JSON form.
 *
 * @param value - The value to copy.
 * @param path - Its JSON path.
 * @param subject - What is being encoded.
 * @param ancestors - Containers on the current path, used to reject cycles.
 * @returns A JSON copy that shares no containers with `value`.
 * @throws {PayloadError} When the value cannot be encoded.
 */
function copyJson(value: unknown, path: string, subject: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw notSerializable(subject, path, `${String(value)} is not a JSON number.`);
    return value === 0 ? 0 : value;
  }
  if (typeof value !== "object")
    throw notSerializable(subject, path, `a ${typeof value} has no JSON form.`, typeof value === "bigint" ? "Send big integers as decimal strings." : undefined);
  if (ancestors.has(value))
    throw notSerializable(subject, path, "the value contains a circular reference.");

  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return copyArray(value, path, subject, ancestors);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw notSerializable(subject, path, `a ${describeObject(value)} is not plain JSON data.`, nonPlainHint(value));
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw notSerializable(subject, path, "symbol-keyed properties have no JSON form.");
    const copy: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      // defineProperty, not assignment: assigning "__proto__" would change the
      // copy's prototype instead of creating a property, so a schema could
      // validate a field that is never sent.
      if (entry !== undefined)
        Object.defineProperty(copy, key, { value: copyJson(entry, `${path}${formatKey(key)}`, subject, ancestors), enumerable: true, writable: true, configurable: true });
    }
    return copy as JsonObject;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Copies an array, rejecting holes and `undefined` entries, which JSON would turn into `null`.
 *
 * @param value - The array to copy entry by entry.
 * @param path - Its JSON path.
 * @param subject - What is being encoded.
 * @param ancestors - Containers on the current path.
 * @returns The JSON copy.
 * @throws {PayloadError} When an entry cannot be encoded.
 */
function copyArray(value: readonly unknown[], path: string, subject: string, ancestors: Set<object>): JsonValue[] {
  const copy: JsonValue[] = [];
  for (let index = 0; index < value.length; index++) {
    const entryPath = `${path}[${index}]`;
    if (!(index in value) || value[index] === undefined)
      throw notSerializable(subject, entryPath, "undefined array entries have no JSON form.", "Use null for missing array entries.");
    copy.push(copyJson(value[index], entryPath, subject, ancestors));
  }
  return copy;
}

/**
 * Formats an object key as a JSON path segment: `.name` for identifier-like keys, `["a b"]` otherwise.
 *
 * @param key - The property name.
 * @returns The path segment.
 */
export function formatKey(key: string): string {
  return /^[A-Z_$][\w$]*$/i.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/**
 * Names the kind of a non-plain object for error messages, for example `Date` or `Map`.
 *
 * @param value - The rejected object.
 * @returns The constructor name, or `non-plain object`.
 */
function describeObject(value: object): string {
  const name: unknown = (value.constructor as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name !== "" && name !== "Object" ? name : "non-plain object";
}

/**
 * Suggests the portable alternative for common non-plain objects.
 *
 * @param value - The rejected object.
 * @returns A hint, or `undefined` when there is no specific advice.
 */
function nonPlainHint(value: object): string | undefined {
  if (value instanceof Date)
    return "Send an ISO 8601 string (for example z.iso.datetime()) and decode it to a Date in the schema's output.";
  if (value instanceof Map || value instanceof Set)
    return "Send a plain object or an array instead.";
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return "Send binary data through a bucket or a bytes payload codec, not inside a JSON payload.";
  return undefined;
}

/**
 * Creates the `HOLQA_PAYLOAD_NOT_SERIALIZABLE` error for one path.
 *
 * @param subject - What was being encoded.
 * @param path - JSON path of the offending value.
 * @param reason - Why the value was rejected.
 * @param hint - Optional guidance.
 * @returns The error to throw.
 */
function notSerializable(subject: string, path: string, reason: string, hint?: string): PayloadError {
  return new PayloadError(diagnosticCodes.payloadNotSerializable, subject, path, reason, hint);
}