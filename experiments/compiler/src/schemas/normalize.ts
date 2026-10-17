import type {
  JsonObject,
  JsonValue
} from "@holqa/experiment-model";

import { canonicalJsonStringify } from "@holqa/compiler";

/**
 * Keywords whose array values are sets: their order carries no meaning, so
 * they are sorted and de-duplicated. Every other array (`enum`, `prefixItems`,
 * `anyOf`, `oneOf`, `allOf`, `examples`) is kept in declaration order, which
 * means reordering them changes the fingerprint. That is a deliberate,
 * conservative choice: a spurious "changed" is safer than a missed change.
 */
const setLikeKeywords: ReadonlySet<string> = new Set(["required", "type"]);

/** Keywords removed because they describe the document, not the contract. */
const strippedKeywords: ReadonlySet<string> = new Set(["$schema"]);

/**
 * Sorts and de-duplicates an array of strings; non-string arrays are returned
 * normalized but in their original order.
 *
 * @param values - The keyword's array value.
 * @returns The set-normalized array.
 */
function normalizeSet(values: readonly JsonValue[]): readonly JsonValue[] {
  if (!values.every(value => typeof value === "string"))
    return values.map(normalizeValue);
  return [...new Set(values)].sort();
}

/**
 * Normalizes a JSON value appearing inside a JSON Schema.
 *
 * @param value - Any JSON value.
 * @returns The normalized value.
 */
function normalizeValue(value: JsonValue): JsonValue {
  if (Array.isArray(value))
    return value.map(normalizeValue);
  if (typeof value === "object" && value !== null)
    return normalizeJsonSchema(value as JsonObject);
  return value;
}

/**
 * Produces the fingerprint form of a JSON Schema: `$schema` is removed at every
 * depth, and set-like keywords (`required`, `type` arrays) are sorted. Object
 * key order needs no handling because canonical JSON sorts keys.
 *
 * Library-specific output (for example the `maximum: 9007199254740991` Zod adds
 * to integers) is not stripped, so fingerprints depend on the schema library
 * and its version. See the experiment README.
 *
 * @param schema - A JSON Schema object.
 * @returns A new, normalized JSON Schema object.
 */
export function normalizeJsonSchema(schema: JsonObject): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (strippedKeywords.has(key))
      continue;
    result[key] = setLikeKeywords.has(key) && Array.isArray(value) ? normalizeSet(value) : normalizeValue(value);
  }
  return result;
}

/**
 * Computes the fingerprint of a normalized schema and its runtime-only notes.
 * The notes are part of the fingerprint because JSON Schema cannot see
 * refinements: `z.string()` and `z.string().refine(...)` produce identical JSON
 * Schema and are distinguishable only through the adapter's notes.
 *
 * @param jsonSchema - A schema already passed through {@link normalizeJsonSchema}.
 * @param runtimeOnly - Sorted runtime-only notes.
 * @returns `sha256:` followed by the lowercase hex digest of the canonical JSON.
 */
export async function fingerprintSchema(jsonSchema: JsonObject, runtimeOnly: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJsonStringify({ jsonSchema, runtimeOnly: [...runtimeOnly] }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}