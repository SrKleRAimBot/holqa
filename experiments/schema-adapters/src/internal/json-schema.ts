import type {
  JsonObject,
  SchemaAdapter,
  SchemaSide,
  StandardSchemaV1
} from "@holqa/experiment-model";

import { isJsonValue } from "@holqa/experiment-model";

/** The result type every adapter's `convert` returns. */
export type ConversionResult = ReturnType<SchemaAdapter["convert"]>;

/**
 * Builds a successful conversion result.
 *
 * @param jsonSchema - The JSON Schema for the requested side.
 * @param runtimeOnly - Constraints enforced at runtime but missing from the JSON Schema.
 * @returns A frozen `ok` result.
 */
export function converted(jsonSchema: JsonObject, runtimeOnly: readonly string[]): ConversionResult {
  return Object.freeze({ ok: true as const, value: Object.freeze({ jsonSchema, runtimeOnly: Object.freeze([...runtimeOnly]) }) });
}

/**
 * Builds a failed conversion result.
 *
 * @param reason - Why the schema cannot be represented portably.
 * @returns A frozen `err` result.
 */
export function unsupported(reason: string): ConversionResult {
  return Object.freeze({ ok: false as const, error: Object.freeze({ reason }) });
}

/**
 * Removes the top-level `$schema` keyword and checks that the converter output
 * is plain JSON. The dialect is fixed by the manifest, so `$schema` adds noise
 * (and differs between libraries) without adding information.
 *
 * @param raw - The converter output.
 * @returns The cleaned JSON Schema, or a failure reason when the output is not plain JSON.
 */
export function cleanJsonSchema(raw: Record<string, unknown>): JsonObject | string {
  const { $schema: _dialect, ...rest } = raw;
  if (!isJsonValue(rest))
    return "The converter produced a value that is not plain JSON.";
  return rest as JsonObject;
}

/**
 * Converts one side of a schema through its Standard JSON Schema converter,
 * turning converter exceptions into failure reasons.
 *
 * @param schema - A schema that implements `~standard.jsonSchema`.
 * @param side - Which side to convert.
 * @returns The cleaned JSON Schema, or a failure reason.
 */
export function convertStandardJsonSchema(schema: StandardSchemaV1, side: SchemaSide): JsonObject | string {
  const props: object = schema["~standard"];
  if (!("jsonSchema" in props) || typeof props.jsonSchema !== "object" || props.jsonSchema === null)
    return `Vendor "${schema["~standard"].vendor}" does not implement Standard JSON Schema.`;
  const converter: object = props.jsonSchema;
  const convert: unknown = side in converter ? (converter as Record<SchemaSide, unknown>)[side] : undefined;
  if (typeof convert !== "function")
    return `Vendor "${schema["~standard"].vendor}" has no ${side} JSON Schema converter.`;
  try {
    const raw: unknown = convert({ target: "draft-2020-12" });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return "The converter did not return a JSON Schema object.";
    return cleanJsonSchema(raw as Record<string, unknown>);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Reads a property of an unknown value without trusting its type.
 *
 * @param value - Any value.
 * @param key - The property name.
 * @returns The property value, or `undefined` when `value` is not an object or lacks the property.
 */
export function property(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || !(key in value))
    return undefined;
  return (value as Record<string, unknown>)[key];
}