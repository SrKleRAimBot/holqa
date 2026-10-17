import type {
  JsonObject,
  StandardSchemaV1
} from "@holqa/experiment-model";

/** How a fake schema's JSON Schema converter behaves for one side. */
type FakeSide = JsonObject | "throw";

/**
 * Creates a minimal Standard Schema from an arbitrary vendor, optionally with a
 * Standard JSON Schema converter, so tests can exercise the compiler's
 * vendor-independent paths without a real schema library.
 *
 * @param vendor - The `~standard.vendor` value.
 * @param jsonSchema - Converter behavior per side, or `undefined` for a schema without a converter.
 * @param jsonSchema.input - What the input converter returns, or `"throw"`.
 * @param jsonSchema.output - What the output converter returns, or `"throw"`.
 * @returns A schema that accepts any value.
 */
export function fakeSchema(vendor: string, jsonSchema?: { readonly input: FakeSide; readonly output: FakeSide }): StandardSchemaV1 {
  /**
   * Returns the configured JSON Schema or throws, imitating a library converter.
   *
   * @param side - The configured behavior.
   * @returns The JSON Schema.
   * @throws {Error} When the side is configured to throw.
   */
  const convert = (side: FakeSide): Record<string, unknown> => {
    if (side === "throw")
      throw new Error("Transforms cannot be represented in JSON Schema");
    return { ...side };
  };
  return {
    "~standard": {
      version: 1,
      vendor,
      validate: value => ({ value }),
      ...(jsonSchema === undefined
        ? {}
        : { jsonSchema: { input: () => convert(jsonSchema.input), output: () => convert(jsonSchema.output) } })
    }
  } as StandardSchemaV1;
}