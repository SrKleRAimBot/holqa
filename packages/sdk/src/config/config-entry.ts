import type {
  InferInput,
  JsonValue,
  StandardSchemaV1
} from "@holqa/core";

import { isJsonValue } from "@holqa/core";

import {
  DeclarationProblems,
  freezeJson
} from "@/internal/declaration";

/**
 * A declared configuration entry. Its name is the key it is declared under in
 * `defineApp({ env })`; its value is supplied by a runtime binding.
 *
 * @typeParam Schema - The value's schema.
 * @typeParam Sensitive - `true` for secrets.
 */
export interface ConfigEntry<Schema extends StandardSchemaV1, Sensitive extends boolean> {
  readonly kind: Sensitive extends true ? "secret" : "variable";
  readonly schema: Schema;
  readonly sensitive: Sensitive;
  readonly defaultValue?: JsonValue;
}

/** Any configuration entry, used as a constraint. */
export interface AnyConfigEntry {
  readonly kind: "secret" | "variable";
  readonly schema: StandardSchemaV1;
  readonly sensitive: boolean;
  readonly defaultValue?: JsonValue;
}

/** A record of configuration entries keyed by name. */
export type EnvRecord = Readonly<Record<string, AnyConfigEntry>>;

/**
 * Options accepted by {@link variable}.
 *
 * @typeParam Schema - The value's schema.
 */
export interface VariableOptions<Schema extends StandardSchemaV1> {
  /** A JSON value used when the variable is not set. Typed as the schema's input. */
  readonly default?: InferInput<Schema> & JsonValue;
}

/**
 * Declares a secret: a sensitive configuration value that bindings validate at
 * startup and that must never appear in manifests, logs or generated clients.
 * Declaring it reads nothing from the environment.
 *
 * @param schema - The value's schema.
 * @returns The configuration entry.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when `schema` is not a Standard Schema.
 */
export function secret<Schema extends StandardSchemaV1>(schema: Schema): ConfigEntry<Schema, true> {
  const problems = new DeclarationProblems("secret");
  problems.schema(schema, "schema");
  problems.throwIfAny();
  return Object.freeze({ kind: "secret" as const, schema, sensitive: true as const });
}

/**
 * Declares a non-sensitive configuration variable with an optional default.
 * Declaring it reads nothing from the environment.
 *
 * @param schema - The value's schema.
 * @param options - Optional settings such as the default value.
 * @returns The configuration entry.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when `schema` is not a Standard Schema or the default is not JSON.
 */
export function variable<Schema extends StandardSchemaV1>(schema: Schema, options?: VariableOptions<Schema>): ConfigEntry<Schema, false> {
  const problems = new DeclarationProblems("variable");
  problems.schema(schema, "schema");
  const defaultValue: unknown = options?.default;
  if (defaultValue !== undefined && !isJsonValue(defaultValue))
    problems.invalid("\"default\" must be a JSON value.");
  problems.throwIfAny();
  return Object.freeze({
    kind: "variable" as const,
    schema,
    sensitive: false as const,
    ...(options?.default === undefined ? {} : { defaultValue: freezeJson(JSON.parse(JSON.stringify(options.default)) as JsonValue) })
  });
}