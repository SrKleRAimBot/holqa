import type {
  SchemaAdapter,
  SchemaSide,
  StandardSchemaV1
} from "@holqa/experiment-model";

import type { ConversionResult } from "@/internal/json-schema";

import {
  converted,
  convertStandardJsonSchema,
  unsupported
} from "@/internal/json-schema";

/**
 * Creates a fallback adapter for a vendor that implements Standard JSON Schema
 * but has no Holqa adapter. It converts faithfully only as far as the vendor's
 * own converter does, and it cannot detect constructs that the converter drops
 * silently. Its conversions must therefore be reported as unverified (the
 * compiler prototype pairs them with `HOLQA_SCHEMA_FIDELITY_UNVERIFIED`).
 *
 * @param vendor - The Standard Schema vendor name, for example `arktype`.
 * @returns A schema adapter whose `library` is marked `(unverified)`.
 */
export function createStandardJsonSchemaAdapter(vendor: string): SchemaAdapter {
  return Object.freeze({
    vendor,
    library: `${vendor} (unverified)`,
    convert: (schema: StandardSchemaV1, side: SchemaSide): ConversionResult => {
      const jsonSchema = convertStandardJsonSchema(schema, side);
      return typeof jsonSchema === "string" ? unsupported(`$: ${jsonSchema}`) : converted(jsonSchema, []);
    }
  });
}