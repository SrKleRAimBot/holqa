import type {
  ConfigDescriptor,
  InferInput,
  JsonValue,
  StandardSchemaV1
} from "@holqa/experiment-model";

import { descriptorProtocol } from "@holqa/experiment-model";

import { checkSchemas } from "@/internal/describe";

/** A declared configuration entry. The entry's name is its key in `defineApp({ env })`. */
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

/**
 * Declares a secret: a sensitive configuration value that is validated at
 * startup and never written to manifests, logs or generated clients.
 *
 * @param schema - The value's schema.
 * @returns The configuration entry.
 */
export function secret<Schema extends StandardSchemaV1>(schema: Schema): ConfigEntry<Schema, true> {
  checkSchemas("secret", { schema });
  return Object.freeze({ kind: "secret" as const, schema, sensitive: true as const });
}

/**
 * Declares a non-sensitive configuration variable with an optional default.
 *
 * @param schema - The value's schema.
 * @param options - Optional settings.
 * @param options.default - A JSON-serializable value used when the variable is not set.
 * @returns The configuration entry.
 */
export function variable<Schema extends StandardSchemaV1>(schema: Schema, options?: { readonly default?: InferInput<Schema> & JsonValue }): ConfigEntry<Schema, false> {
  checkSchemas("variable", { schema });
  return Object.freeze({
    kind: "variable" as const,
    schema,
    sensitive: false as const,
    ...(options?.default === undefined ? {} : { defaultValue: options.default })
  });
}

/**
 * Builds the descriptor for a named configuration entry.
 *
 * @param name - The key the entry was declared under in `env`.
 * @param entry - The secret or variable declaration.
 * @returns The configuration descriptor.
 */
export function configDescriptor(name: string, entry: AnyConfigEntry): ConfigDescriptor {
  return Object.freeze({
    protocol: descriptorProtocol,
    type: "config",
    name,
    sensitive: entry.sensitive,
    schema: entry.schema,
    ...(entry.defaultValue === undefined ? {} : { defaultValue: entry.defaultValue })
  });
}