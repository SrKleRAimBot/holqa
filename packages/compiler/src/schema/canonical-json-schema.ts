import type {
  JsonObject,
  JsonValue
} from "@holqa/core";

import { canonicalJsonStringify } from "@/manifest/canonical-json";

/** Keywords whose value is a single subschema. */
const subschemaKeywords: readonly string[] = [
  "additionalProperties",
  "items",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema"
];

/** Keywords whose value maps names to subschemas. */
const subschemaMapKeywords: readonly string[] = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

/** Keywords whose value is an ordered list of subschemas. */
const orderedSubschemaListKeywords: readonly string[] = ["prefixItems"];

/** Keywords whose value is a list of subschemas with set semantics: member order does not change what is accepted. */
const subschemaSetKeywords: readonly string[] = ["anyOf", "oneOf", "allOf"];

/**
 * Rewrites a JSON Schema (draft 2020-12) into Holqa's canonical form, so that
 * schemas which accept exactly the same values and differ only in
 * presentation become identical. Combined with canonical JSON, which sorts
 * object keys, this makes fingerprints independent of declaration order.
 *
 * Rules:
 * - The top-level `$schema` keyword is removed; the dialect is fixed by the contract.
 * - `required` and `type` lists are de-duplicated and sorted; a one-element `type` list becomes a string.
 * - `enum` values and `anyOf`, `oneOf` and `allOf` members are de-duplicated
 *   and sorted by their canonical JSON. This is skipped for the whole schema
 *   when a `$ref` points into one of these lists, because reordering would change its target.
 * - Data-valued keywords (`const`, `default`, `examples`) are never reordered.
 *
 * Canonicalization never removes a constraint and never changes which values
 * a schema accepts.
 *
 * @param schema - A JSON Schema object, for example an adapter's output.
 * @returns The canonical schema, as a new object.
 * @throws {CanonicalJsonError} When the schema contains values without a canonical JSON form.
 */
export function canonicalizeJsonSchema(schema: JsonObject): JsonObject {
  const { $schema: _dialect, ...rest } = schema;
  const sortSets = !hasRefIntoSetKeyword(rest);
  return canonicalizeNode(rest, sortSets) as JsonObject;
}

/**
 * Canonicalizes one subschema. Boolean schemas and non-object values are returned unchanged.
 *
 * @param node - The subschema.
 * @param sortSets - Whether set-like lists may be reordered.
 * @returns The canonical subschema.
 */
function canonicalizeNode(node: JsonValue, sortSets: boolean): JsonValue {
  if (typeof node !== "object" || node === null || Array.isArray(node))
    return node;
  const result: Record<string, JsonValue> = {};
  for (const [keyword, value] of Object.entries(node))
    result[keyword] = canonicalizeKeyword(keyword, value, sortSets);
  return result;
}

/**
 * Canonicalizes the value of one keyword according to the keyword's meaning.
 *
 * @param keyword - The JSON Schema keyword.
 * @param value - Its value.
 * @param sortSets - Whether set-like lists may be reordered.
 * @returns The canonical value.
 */
function canonicalizeKeyword(keyword: string, value: JsonValue, sortSets: boolean): JsonValue {
  // Draft 2019-09 tuples write `items` as an ordered list of subschemas.
  if (subschemaKeywords.includes(keyword))
    return Array.isArray(value) ? value.map(subschema => canonicalizeNode(subschema, sortSets)) : canonicalizeNode(value, sortSets);
  if (subschemaMapKeywords.includes(keyword) && isObject(value))
    return Object.fromEntries(Object.entries(value).map(([name, subschema]) => [name, canonicalizeNode(subschema, sortSets)]));
  if (orderedSubschemaListKeywords.includes(keyword) && Array.isArray(value))
    return value.map(subschema => canonicalizeNode(subschema, sortSets));
  if (subschemaSetKeywords.includes(keyword) && Array.isArray(value)) {
    const members = value.map(subschema => canonicalizeNode(subschema, sortSets));
    return sortSets ? sortedUnique(members) : members;
  }
  if (keyword === "required" && Array.isArray(value) && value.every(entry => typeof entry === "string"))
    return [...new Set(value)].sort(compareCodeUnits);
  if (keyword === "type" && Array.isArray(value) && value.every(entry => typeof entry === "string")) {
    const types = [...new Set(value)].sort(compareCodeUnits);
    return types.length === 1 ? types[0]! : types;
  }
  if (keyword === "enum" && Array.isArray(value) && sortSets)
    return sortedUnique(value);
  return value;
}

/**
 * De-duplicates values and sorts them by their canonical JSON text.
 *
 * @param values - The values to sort.
 * @returns A new, sorted list without duplicates.
 */
function sortedUnique(values: readonly JsonValue[]): JsonValue[] {
  const byText = new Map<string, JsonValue>();
  for (const value of values)
    byText.set(canonicalJsonStringify(value), value);
  return [...byText.keys()].sort(compareCodeUnits).map(text => byText.get(text)!);
}

/**
 * Reports whether any `$ref` in the schema points into a list whose order canonicalization would change.
 *
 * @param node - The schema to search.
 * @returns `true` when a reference such as `#/anyOf/1` exists.
 */
function hasRefIntoSetKeyword(node: JsonValue): boolean {
  if (Array.isArray(node))
    return node.some(hasRefIntoSetKeyword);
  if (!isObject(node))
    return false;
  const { $ref: ref } = node;
  if (typeof ref === "string" && /\/(?:anyOf|oneOf|allOf|enum)\/\d/.test(ref))
    return true;
  return Object.values(node).some(hasRefIntoSetKeyword);
}

/**
 * Reports whether a JSON value is an object (not an array or `null`).
 *
 * @param value - The value to inspect.
 * @returns `true` for JSON objects.
 */
function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Orders strings by UTF-16 code unit, independent of locale.
 *
 * @param left - The first string.
 * @param right - The second string.
 * @returns A negative number, zero or a positive number.
 */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}