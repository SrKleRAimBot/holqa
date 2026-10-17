import type { Result } from "@holqa/core";

import type { JsonObject } from "@/json";
import type { StandardSchemaV1 } from "@/standard-schema";

/** Which side of a schema to describe: what producers send (`input`) or what consumers receive (`output`). */
export type SchemaSide = "input" | "output";

/** A successful conversion of a schema to portable JSON Schema. */
export interface SchemaConversion {
  /** JSON Schema (draft 2020-12) describing the requested side. */
  readonly jsonSchema: JsonObject;
  /**
   * Constraints the schema enforces at runtime that the JSON Schema does not
   * express (for example a custom refinement). Empty means the conversion is
   * faithful as far as the adapter can tell.
   */
  readonly runtimeOnly: readonly string[];
}

/** Why a schema cannot be converted. */
export interface SchemaConversionFailure {
  readonly reason: string;
}

/**
 * Converts one schema library's schemas to JSON Schema and reports what the
 * conversion loses. Adapters live in integration packages and depend inward on
 * this contract; the model and compiler never import a schema library.
 */
export interface SchemaAdapter {
  /** The Standard Schema `vendor` this adapter handles, for example `zod`. */
  readonly vendor: string;
  /** Library and version, recorded so that fingerprint changes caused by a library upgrade are explainable. */
  readonly library: string;
  /**
   * Converts a schema.
   *
   * @param schema - A schema whose `~standard.vendor` equals {@link SchemaAdapter.vendor}.
   * @param side - Which side to describe.
   * @returns The conversion, or why the schema cannot be represented.
   */
  readonly convert: (schema: StandardSchemaV1, side: SchemaSide) => Result<SchemaConversion, SchemaConversionFailure>;
}