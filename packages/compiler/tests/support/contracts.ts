import type {
  JsonObject,
  RuntimeOnlyConstraint,
  SchemaAdapter,
  StandardSchemaV1
} from "@holqa/core";

import type {
  SchemaContract,
  SchemaContractRecord,
  SchemaFidelity
} from "@/schema/schema-contract";

import { ok } from "@holqa/core";

import { canonicalizeJsonSchema } from "@/schema/canonical-json-schema";
import { fingerprintSchemaContract } from "@/schema/fingerprint";
import {
  jsonSchemaDialect,
  schemaContractFormat
} from "@/schema/schema-contract";

/** Settings for {@link contractOf}. */
export interface ContractFixtureOptions {
  readonly runtimeOnly?: readonly RuntimeOnlyConstraint[];
  readonly fidelity?: SchemaFidelity;
  readonly library?: string;
}

/**
 * Builds a contract whose input and output sides are the given JSON Schema.
 *
 * @param jsonSchema - The wire JSON Schema.
 * @param options - Runtime-only constraints, fidelity and library.
 * @returns A canonical contract.
 */
export function contractOf(jsonSchema: JsonObject, options: ContractFixtureOptions = {}): SchemaContract {
  const side = { jsonSchema: canonicalizeJsonSchema(jsonSchema), runtimeOnly: options.runtimeOnly ?? [] };
  return {
    format: schemaContractFormat,
    dialect: jsonSchemaDialect,
    encoding: "json",
    source: { vendor: "test", library: options.library ?? "test@1", fidelity: options.fidelity ?? "verified" },
    input: side,
    output: { representable: true, ...side }
  };
}

/**
 * Builds a fingerprinted contract record from a JSON Schema.
 *
 * @param jsonSchema - The wire JSON Schema.
 * @param schemaVersion - The declared version.
 * @param options - Runtime-only constraints, fidelity and library.
 * @returns A record with the computed fingerprint.
 */
export async function recordOf(jsonSchema: JsonObject, schemaVersion = 1, options: ContractFixtureOptions = {}): Promise<SchemaContractRecord> {
  const contract = contractOf(jsonSchema, options);
  return { schemaVersion, fingerprint: await fingerprintSchemaContract(contract), contract };
}

/**
 * Creates a Standard Schema whose vendor is `test` and that accepts every value.
 *
 * @param vendor - The vendor name.
 * @param jsonSchema - When given, the schema also implements Standard JSON Schema and returns this for both sides.
 * @returns A schema that accepts every value unchanged.
 */
export function fakeSchema(vendor = "test", jsonSchema?: Record<string, unknown>): StandardSchemaV1 {
  const props = {
    version: 1 as const,
    vendor,
    validate: (value: unknown) => ({ value }),
    ...(jsonSchema === undefined ? {} : { jsonSchema: { input: () => jsonSchema, output: () => jsonSchema } })
  };
  return { "~standard": props };
}

/**
 * Creates an adapter for the `test` vendor that describes every schema with fixed results.
 *
 * @param describe - The adapter's describe function.
 * @returns An adapter for the `test` vendor.
 */
export function fakeAdapter(describe: SchemaAdapter["describe"] = () => ok({ jsonSchema: { type: "string" }, runtimeOnly: [] })): SchemaAdapter {
  return { vendor: "test", library: "test@1", describe };
}