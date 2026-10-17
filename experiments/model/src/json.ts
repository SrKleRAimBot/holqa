/** A value that survives a JSON round trip unchanged. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/** A plain JSON object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * Reports whether a value is a plain JSON value: `null`, a boolean, a finite
 * number, a string, an array of JSON values, or a plain object of JSON values.
 *
 * @param value - The value to inspect.
 * @returns `true` when the value can be serialized without loss.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number")
    return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every(isJsonValue);
  if (typeof value !== "object")
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return false;
  return Object.values(value).every(isJsonValue);
}