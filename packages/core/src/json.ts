/** A value that survives a JSON round trip unchanged. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/**
 * An object type with no properties. Unlike `{}`, which accepts any
 * non-nullish value (even `42`), it accepts only objects without own data.
 */
export interface EmptyObject {
  readonly [key: string]: never;
}

/** A plain JSON object whose values are all {@link JsonValue}s. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * Reports whether a value is plain JSON data: `null`, a boolean, a finite
 * number, a string, an array of JSON values, or a plain object (prototype
 * `Object.prototype` or `null`) of JSON values. Cycles are rejected.
 *
 * @param value - The value to inspect, typically untrusted input.
 * @returns `true` when the value can be serialized and parsed back without loss.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueWithin(value, new Set());
}

/**
 * Checks one value for {@link isJsonValue}, tracking the containers on the
 * current path so that circular structures are rejected instead of recursing forever.
 *
 * @param value - The value to inspect.
 * @param path - Arrays and objects currently being inspected higher up the tree.
 * @returns `true` when the value is plain JSON data.
 */
function isJsonValueWithin(value: unknown, path: Set<object>): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number")
    return Number.isFinite(value);
  if (typeof value !== "object" || path.has(value))
    return false;
  if (!Array.isArray(value)) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      return false;
  }
  path.add(value);
  const valid = Object.values(value).every(entry => isJsonValueWithin(entry, path));
  path.delete(value);
  return valid;
}