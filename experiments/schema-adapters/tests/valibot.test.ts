import type {
  SchemaConversion,
  SchemaSide,
  StandardSchemaV1
} from "@holqa/experiment-model";

import {
  describe,
  expect,
  it
} from "bun:test";
import * as v from "valibot";

import { valibotAdapter } from "@/valibot";

/**
 * Converts a schema and fails the test when the conversion is rejected.
 *
 * @param schema - The Valibot schema.
 * @param side - Which side to convert.
 * @returns The successful conversion.
 * @throws {Error} When the adapter rejects the schema.
 */
function convert(schema: StandardSchemaV1, side: SchemaSide = "input"): SchemaConversion {
  const result = valibotAdapter.convert(schema, side);
  if (!result.ok)
    throw new Error(`Expected a conversion, got: ${result.error.reason}`);
  return result.value;
}

/** A recursive category tree. */
const category: v.GenericSchema<{ name: string; children: unknown[] }> = v.object({
  name: v.string(),
  children: v.array(v.lazy(() => category))
});

describe("valibotAdapter", () => {
  it("converts an object and removes $schema", () => {
    const { jsonSchema, runtimeOnly } = convert(v.object({ sku: v.pipe(v.string(), v.minLength(1)), quantity: v.pipe(v.number(), v.integer(), v.minValue(1)) }));
    expect(jsonSchema).toEqual({
      type: "object",
      properties: { sku: { type: "string", minLength: 1 }, quantity: { type: "integer", minimum: 1 } },
      required: ["sku", "quantity"]
    });
    expect(runtimeOnly).toEqual([]);
  });

  it("reports check actions as runtime-only instead of failing or dropping them", () => {
    const schema = v.object({ sku: v.pipe(v.string(), v.check(value => value.startsWith("SKU-"))) });
    const { jsonSchema, runtimeOnly } = convert(schema);
    expect(jsonSchema).toEqual({ type: "object", properties: { sku: { type: "string" } }, required: ["sku"] });
    expect(runtimeOnly).toEqual(["$.sku: validation \"check\" is validated at runtime only"]);
  });

  it("describes the input side of a transform and rejects an output side without a schema", () => {
    const schema = v.pipe(v.string(), v.transform(value => value.length));
    expect(convert(schema, "input").jsonSchema).toEqual({ type: "string" });
    const output = valibotAdapter.convert(schema, "output");
    expect(output.ok).toBe(false);
  });

  it("describes the output side when the pipe ends with a schema", () => {
    expect(convert(v.pipe(v.string(), v.transform(Number), v.number()), "output").jsonSchema).toEqual({ type: "number" });
  });

  it("reports that the converter marks defaulted output properties as optional", () => {
    const schema = v.object({ priority: v.optional(v.picklist(["normal", "urgent"]), "normal") });
    const { jsonSchema, runtimeOnly } = convert(schema, "output");
    expect(jsonSchema).toMatchObject({ required: [] });
    expect(runtimeOnly).toEqual(["$.priority: always present in output because of its default, but the converter marks it optional"]);
  });

  it("reports that isoDateTime differs from JSON Schema's date-time format", async () => {
    const schema = v.pipe(v.string(), v.isoDateTime());
    expect(convert(schema).jsonSchema).toEqual({ type: "string", format: "date-time" });
    expect(convert(schema).runtimeOnly).toHaveLength(1);
    // RFC 3339 requires seconds and an offset. Valibot accepts the short form and rejects the RFC 3339 form.
    expect((await schema["~standard"].validate("2026-10-17T10:00")).issues).toBeUndefined();
    expect((await schema["~standard"].validate("2026-10-17T10:00:00Z")).issues).toBeDefined();
  });

  it("represents recursive schemas with generated, order-dependent definition names", () => {
    const { jsonSchema } = convert(category);
    const { $defs: definitions } = jsonSchema;
    expect(Object.keys(definitions as object)).toEqual(["0"]);
  });

  it.each([
    ["date", v.date()],
    ["bigint", v.bigint()],
    ["custom", v.custom<Blob>(value => value instanceof Blob)]
  ] as const)("rejects %s instead of approximating it", (_name, schema) => {
    expect(valibotAdapter.convert(schema, "input").ok).toBe(false);
  });
});