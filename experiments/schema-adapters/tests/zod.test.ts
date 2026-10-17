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
import { z } from "zod";

import {
  createZodAdapter,
  zodAdapter
} from "@/zod";

/**
 * Converts a schema and fails the test when the conversion is rejected.
 *
 * @param schema - The Zod schema.
 * @param side - Which side to convert.
 * @returns The successful conversion.
 * @throws {Error} When the adapter rejects the schema.
 */
function convert(schema: StandardSchemaV1, side: SchemaSide = "input"): SchemaConversion {
  const result = zodAdapter.convert(schema, side);
  if (!result.ok)
    throw new Error(`Expected a conversion, got: ${result.error.reason}`);
  return result.value;
}

/**
 * Returns the rejection reason of a conversion, failing the test when it succeeds.
 *
 * @param schema - The Zod schema.
 * @param side - Which side to convert.
 * @returns The failure reason.
 * @throws {Error} When the adapter accepts the schema.
 */
function rejection(schema: StandardSchemaV1, side: SchemaSide = "input"): string {
  const result = zodAdapter.convert(schema, side);
  if (result.ok)
    throw new Error(`Expected a rejection, got: ${JSON.stringify(result.value)}`);
  return result.error.reason;
}

/** A recursive category tree, declared with Zod's getter syntax. */
const category: z.ZodType<{ name: string; children: unknown[] }> = z.object({
  name: z.string(),
  get children() {
    return z.array(category);
  }
});

describe("zodAdapter", () => {
  it("identifies itself as the zod vendor", () => {
    expect(zodAdapter.vendor).toBe("zod");
    expect(zodAdapter.library).toBe("zod@4");
    expect(createZodAdapter({ version: "4.6.7" }).library).toBe("zod@4.6.7");
  });

  it("converts an object faithfully and removes $schema", () => {
    const { jsonSchema, runtimeOnly } = convert(z.object({ sku: z.string().min(1), quantity: z.number().int().positive() }));
    expect(jsonSchema).toEqual({
      type: "object",
      properties: {
        sku: { type: "string", minLength: 1 },
        quantity: { type: "integer", exclusiveMinimum: 0, maximum: 9007199254740991 }
      },
      required: ["sku", "quantity"]
    });
    expect(runtimeOnly).toEqual([]);
  });

  it("preserves declaration order in properties and required, so key order is a fingerprint input", () => {
    const ab = convert(z.object({ a: z.string(), b: z.string() })).jsonSchema;
    const ba = convert(z.object({ b: z.string(), a: z.string() })).jsonSchema;
    expect(ab).toMatchObject({ required: ["a", "b"] });
    expect(ba).toMatchObject({ required: ["b", "a"] });
  });

  it("distinguishes the input and output sides of defaults", () => {
    const schema = z.object({ priority: z.enum(["normal", "urgent"]).default("normal") });
    expect(convert(schema, "input").jsonSchema).toEqual({
      type: "object",
      properties: { priority: { default: "normal", type: "string", enum: ["normal", "urgent"] } }
    });
    expect(convert(schema, "output").jsonSchema).toEqual({
      type: "object",
      properties: { priority: { default: "normal", type: "string", enum: ["normal", "urgent"] } },
      required: ["priority"],
      additionalProperties: false
    });
  });

  it.each([
    ["array", z.array(z.string())],
    ["discriminated union", z.discriminatedUnion("kind", [z.object({ kind: z.literal("card"), last4: z.string() }), z.object({ kind: z.literal("invoice") })])],
    ["union", z.union([z.string(), z.number()])],
    ["record", z.record(z.string(), z.number())],
    ["nullable", z.string().nullable()],
    ["tuple", z.tuple([z.string(), z.number()])],
    ["iso datetime", z.iso.datetime()],
    ["brand", z.string().brand<"OrderId">()],
    ["codec input", z.codec(z.iso.datetime(), z.date(), { decode: value => new Date(value), encode: date => date.toISOString() })]
  ] as const)("converts %s without runtime-only constraints", (_name, schema) => {
    expect(convert(schema).runtimeOnly).toEqual([]);
  });

  it("represents recursive schemas with references and terminates", () => {
    const { jsonSchema } = convert(category);
    expect(jsonSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#" } } },
      required: ["name", "children"]
    });
  });

  it("keeps named definitions declared with meta({ id })", () => {
    const orderId = z.string().meta({ id: "OrderId" });
    const { jsonSchema } = convert(z.object({ orderId }));
    expect(jsonSchema).toEqual({
      type: "object",
      properties: { orderId: { $ref: "#/$defs/OrderId" } },
      required: ["orderId"],
      $defs: { OrderId: { type: "string" } }
    });
  });

  it("reports refinements that Zod's own converter drops silently", () => {
    const schema = z.object({
      sku: z.string().refine(value => value.startsWith("SKU-")),
      lines: z.array(z.object({ quantity: z.number().superRefine(() => undefined) }))
    }).refine(order => order.lines.length > 0);
    expect(convert(schema).runtimeOnly).toEqual([
      "$: custom refinement is validated at runtime only",
      "$.sku: custom refinement is validated at runtime only",
      "$.lines[*].quantity: custom refinement is validated at runtime only"
    ]);
  });

  it("reports async refinements, value rewriting, pipes, preprocessing, coercion and catch", () => {
    expect(convert(z.string().refine(async () => true)).runtimeOnly).toEqual(["$: custom refinement is validated at runtime only"]);
    expect(convert(z.string().trim()).runtimeOnly).toEqual(["$: value is rewritten during validation (for example trim or toLowerCase)"]);
    expect(convert(z.string().pipe(z.coerce.number())).runtimeOnly).toEqual(["$: piped into a second schema whose constraints are validated at runtime only"]);
    expect(convert(z.preprocess(value => value, z.string())).runtimeOnly).toContain("$: input is preprocessed by a function before validation");
    expect(convert(z.coerce.number()).runtimeOnly).toEqual(["$: input is coerced, so values the JSON Schema rejects may be accepted"]);
    expect(convert(z.string().catch("fallback")).runtimeOnly).toEqual(["$: invalid input is replaced by a fallback value instead of being rejected"]);
  });

  it("converts the input side of a transform but rejects its output side", () => {
    const schema = z.string().transform(value => value.length);
    expect(convert(schema, "input").jsonSchema).toEqual({ type: "string" });
    expect(rejection(schema, "output")).toContain("transform");
  });

  it.each([
    ["date", z.date(), "Date"],
    ["bigint", z.bigint(), "BigInt"],
    ["custom", z.custom<Blob>(value => value instanceof Blob), "z.custom()"],
    ["map", z.map(z.string(), z.string()), "Map"],
    ["promise", z.promise(z.string()), "Promises"],
    ["file", z.file(), "File"],
    ["nested date", z.object({ placedAt: z.date() }), "$.placedAt"]
  ] as const)("rejects %s instead of approximating it", (_name, schema, fragment) => {
    expect(rejection(schema)).toContain(fragment);
  });

  it("rejects values that are not Zod schemas", () => {
    const foreign: StandardSchemaV1 = { "~standard": { version: 1, vendor: "zod", validate: value => ({ value }) } };
    expect(rejection(foreign)).toContain("not a Zod schema");
  });
});