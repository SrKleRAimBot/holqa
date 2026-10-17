import type { Diagnostic } from "@holqa/core";

import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

/**
 * A value that can be represented in Holqa's canonical JSON format.
 */
export type CanonicalJsonValue
  = | null
    | boolean
    | number
    | string
    | readonly CanonicalJsonValue[]
    | { readonly [key: string]: CanonicalJsonValue };

/**
 * Thrown when a value cannot be serialized deterministically.
 *
 * The attached {@link CanonicalJsonError.diagnostic} carries the
 * `HOLQA_MANIFEST_NOT_SERIALIZABLE` code and the JSON path of the offending value.
 */
export class CanonicalJsonError extends Error {
  /** The structured diagnostic describing the serialization failure. */
  readonly diagnostic: Diagnostic;

  /**
   * Creates an error for a value at `path` that has no canonical JSON form.
   *
   * @param path - The JSON path (for example `$.resources[0].id`) of the rejected value.
   * @param reason - Why the value was rejected.
   */
  constructor(path: string, reason: string) {
    const message = `Value at ${path} cannot be serialized: ${reason}`;
    super(message);
    this.name = "CanonicalJsonError";
    this.diagnostic = createDiagnostic({
      code: diagnosticCodes.manifestNotSerializable,
      severity: "error",
      message
    });
  }
}

/**
 * Serializes a value to canonical JSON so that semantically equal inputs
 * always produce byte-identical output.
 *
 * Canonicalization rules:
 * - Object keys are sorted by UTF-16 code unit order at every depth.
 * - Output uses two-space indentation and `\n` line endings, with no trailing newline.
 * - `-0` is serialized as `0`.
 *
 * Unlike `JSON.stringify`, this function never silently drops or coerces data.
 * It throws for `undefined`, functions, symbols, bigints, non-finite numbers,
 * non-plain objects (such as `Date` or `Map`), and circular references.
 *
 * This is the serialization foundation for the future application manifest;
 * it does not itself define the manifest schema.
 *
 * @param value - The value to serialize.
 * @returns The canonical JSON text.
 * @throws {CanonicalJsonError} When any part of `value` has no canonical JSON representation.
 *
 * @example
 * ```ts
 * canonicalJsonStringify({ b: 1, a: [true, null] });
 * // => '{\n  "a": [\n    true,\n    null\n  ],\n  "b": 1\n}'
 * ```
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$", new Set()), null, 2);
}

/**
 * Recursively validates `value` and rebuilds it with sorted object keys.
 *
 * @param value - The value to canonicalize.
 * @param path - The JSON path of `value`, used in error messages.
 * @param ancestors - Objects currently being visited, used to detect cycles.
 * @returns A structurally equal value whose objects have sorted keys.
 * @throws {CanonicalJsonError} When `value` contains unsupported data.
 */
function canonicalize(value: unknown, path: string, ancestors: Set<object>): CanonicalJsonValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value))
        throw new CanonicalJsonError(path, `non-finite number ${String(value)}`);
      return Object.is(value, -0) ? 0 : value;
    case "object":
      if (value === null)
        return null;
      return canonicalizeObject(value, path, ancestors);
    default:
      throw new CanonicalJsonError(path, `unsupported type "${typeof value}"`);
  }
}

/**
 * Canonicalizes an array or plain object, rejecting cycles and class instances.
 *
 * @param value - The non-null object to canonicalize.
 * @param path - The JSON path of `value`.
 * @param ancestors - Objects currently being visited, used to detect cycles.
 * @returns The canonicalized array or key-sorted object.
 * @throws {CanonicalJsonError} When `value` is circular, not a plain object, or contains unsupported data.
 */
function canonicalizeObject(value: object, path: string, ancestors: Set<object>): CanonicalJsonValue {
  if (ancestors.has(value))
    throw new CanonicalJsonError(path, "circular reference");

  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item: unknown, index) => canonicalize(item, `${path}[${index}]`, ancestors));

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new CanonicalJsonError(path, "only plain objects and arrays are supported");

    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort())
      result[key] = canonicalize((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
    return result;
  } finally {
    ancestors.delete(value);
  }
}