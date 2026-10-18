import type {
  JsonObject,
  SchemaConversionProblem,
  SchemaSide,
  SchemaSideDescription,
  StandardSchemaV1
} from "@holqa/core";

import {
  describe,
  expect,
  it
} from "bun:test";
import { z } from "zod";
import * as zm from "zod/mini";

import {
  createZodAdapter,
  isZodSchema,
  zodAdapter
} from "@/adapter";

/**
 * Describes a schema side that must convert.
 *
 * @param schema - The Zod schema.
 * @param side - The side to describe.
 * @returns The description.
 */
function described(schema: StandardSchemaV1, side: SchemaSide = "input"): SchemaSideDescription {
  const result = zodAdapter.describe(schema, side);
  if (!result.ok)
    throw new Error(`Expected ${side} to convert: ${result.error.reason}`);
  return result.value;
}

/**
 * Describes a schema side that must fail.
 *
 * @param schema - The Zod schema.
 * @param side - The side to describe.
 * @returns The reason and path the adapter reported.
 */
function problem(schema: StandardSchemaV1, side: SchemaSide = "input"): SchemaConversionProblem {
  const result = zodAdapter.describe(schema, side);
  if (result.ok)
    throw new Error(`Expected ${side} to fail.`);
  return result.error;
}

/**
 * Returns a side's JSON Schema.
 *
 * @param schema - The Zod schema.
 * @param side - The side to describe.
 * @returns The JSON Schema.
 */
function json(schema: StandardSchemaV1, side: SchemaSide = "input"): JsonObject {
  return described(schema, side).jsonSchema;
}

describe("supported portable types", () => {
  it.each([
    ["string", z.string().min(1).max(5), { type: "string", minLength: 1, maxLength: 5 }],
    ["number", z.number().gt(0).lte(10), { type: "number", exclusiveMinimum: 0, maximum: 10 }],
    ["integer", z.int().min(1), { type: "integer", minimum: 1, maximum: 9007199254740991 }],
    ["boolean", z.boolean(), { type: "boolean" }],
    ["null", z.null(), { type: "null" }],
    ["literal", z.literal("a"), { type: "string", const: "a" }],
    ["enum", z.enum(["normal", "urgent"]), { type: "string", enum: ["normal", "urgent"] }],
    ["array", z.array(z.string()).min(1), { type: "array", items: { type: "string" }, minItems: 1 }],
    ["nullable", z.string().nullable(), { type: ["string", "null"] }],
    ["union of primitives", z.union([z.string(), z.number()]), { type: ["string", "number"] }],
    ["union of objects", z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]), { anyOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object", properties: { b: { type: "number" } }, required: ["b"] }] }],
    ["tuple", z.tuple([z.string(), z.number()]), { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false, minItems: 2, maxItems: 2 }],
    ["record", z.record(z.string(), z.number()), { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "number" } }],
    ["unknown", z.unknown(), {}]
  ])("describes %s faithfully", (_name, schema, expected) => {
    expect(described(schema)).toEqual({ jsonSchema: expected, runtimeOnly: [] });
  });

  it("describes objects with optional fields and strictness", () => {
    expect(json(z.object({ id: z.string(), note: z.string().optional() }))).toEqual({
      type: "object",
      properties: { id: { type: "string" }, note: { type: "string" } },
      required: ["id"]
    });
    expect(json(z.strictObject({ id: z.string() }))).toMatchObject({ additionalProperties: false });
  });

  it("describes discriminated unions as oneOf with literal discriminators", () => {
    const schema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("card"), last4: z.string() }), z.object({ kind: z.literal("bank"), iban: z.string() })]);
    expect(json(schema)).toMatchObject({ oneOf: [{ properties: { kind: { type: "string", const: "card" } } }, { properties: { kind: { type: "string", const: "bank" } } }] });
  });

  it("describes recursive schemas with references", () => {
    interface Category { name: string; children: Category[] }
    const category: z.ZodType<Category> = z.object({ name: z.string(), get children() {
      return z.array(category);
    } });
    expect(json(category)).toEqual({ type: "object", properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#" } } }, required: ["name", "children"] });
  });

  it("describes ISO date-time strings with a format", () => {
    expect(json(z.iso.datetime())).toMatchObject({ type: "string", format: "date-time" });
  });

  it("supports Zod Mini schemas", () => {
    expect(described(zm.object({ id: zm.string() }))).toEqual({ jsonSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, runtimeOnly: [] });
  });

  it("never emits the $schema keyword", () => {
    expect("$schema" in json(z.string())).toBe(false);
  });
});

describe("defaults", () => {
  const schema = z.object({ priority: z.enum(["normal", "urgent"]).default("normal") });

  it("make the property optional with a default on the input side", () => {
    expect(json(schema)).toEqual({ type: "object", properties: { priority: { type: "string", enum: ["normal", "urgent"], default: "normal" } } });
  });

  it("make the property required on the output side", () => {
    expect(json(schema, "output")).toMatchObject({ required: ["priority"] });
  });
});

describe("transformations", () => {
  it("describe the input of a transform and reject its output", () => {
    const schema = z.object({ amount: z.string().transform(Number) });
    expect(json(schema)).toEqual({ type: "object", properties: { amount: { type: "string" } }, required: ["amount"] });
    expect(problem(schema, "output").path).toBe("$.amount");
  });

  it("describe both sides of a transform piped into a schema; the second schema's rules are runtime-only on the wire", () => {
    const schema = z.string().transform(Number).pipe(z.number().min(1));
    expect(described(schema)).toEqual({ jsonSchema: { type: "string" }, runtimeOnly: [expect.objectContaining({ path: "$", kind: "pipe" })] });
    expect(json(schema, "output")).toEqual({ type: "number", minimum: 1 });
  });

  it("describe a codec's wire side and reject its Date output with a hint", () => {
    const schema = z.object({ placedAt: z.codec(z.iso.datetime(), z.date(), { decode: text => new Date(text), encode: date => date.toISOString() }) });
    expect(json(schema)).toMatchObject({ properties: { placedAt: { type: "string", format: "date-time" } } });
    expect(problem(schema, "output")).toMatchObject({ path: "$.placedAt", reason: expect.stringContaining("Date") });
  });

  it("record preprocessing as runtime-only", () => {
    const schema = z.preprocess(value => String(value), z.string());
    expect(described(schema).runtimeOnly).toEqual([expect.objectContaining({ path: "$", kind: "preprocess" })]);
  });

  it("record a piped second schema as runtime-only on the input side", () => {
    expect(described(z.string().pipe(z.string().min(3))).runtimeOnly).toEqual([expect.objectContaining({ kind: "pipe" })]);
  });
});

describe("runtime-only constraints", () => {
  it("report refinements and rewrites with their nested path", () => {
    const schema = z.object({ lines: z.array(z.object({ sku: z.string().trim().refine(value => value.startsWith("SKU-")) })) });
    expect(described(schema).runtimeOnly.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "$.lines[*].sku", kind: "rewrite" },
      { path: "$.lines[*].sku", kind: "refinement" }
    ]);
  });

  it("report object-level and superRefine refinements", () => {
    const schema = z.object({ a: z.number(), b: z.number() }).superRefine(() => undefined);
    expect(described(schema).runtimeOnly).toEqual([expect.objectContaining({ path: "$", kind: "refinement" })]);
  });

  it("report coercion and fallbacks on the input side only", () => {
    expect(described(z.coerce.number()).runtimeOnly).toEqual([expect.objectContaining({ kind: "coercion" })]);
    expect(described(z.coerce.number(), "output").runtimeOnly).toEqual([]);
    expect(described(z.string().catch("x")).runtimeOnly).toEqual([expect.objectContaining({ kind: "fallback" })]);
  });

  it("quote keys that are not identifiers in paths", () => {
    expect(described(z.object({ "unit price": z.number().refine(Boolean) })).runtimeOnly[0]!.path).toBe("$[\"unit price\"]");
  });
});

describe("unsupported constructs", () => {
  it.each([
    ["Date", z.date(), "Date"],
    ["bigint", z.bigint(), "BigInt"],
    ["Map", z.map(z.string(), z.number()), "Map"],
    ["Set", z.set(z.string()), "Set"],
    ["custom", z.custom<string>(value => typeof value === "string"), "z.custom()"],
    ["promise", z.promise(z.string()), "Promises"],
    ["file", z.file(), "File"],
    ["symbol", z.symbol(), "Symbols"],
    ["undefined", z.undefined(), "undefined"],
    ["NaN", z.nan(), "NaN"],
    ["success", z.success(z.string()), "boolean"]
  ])("rejects %s with a reason", (_name, schema, reason) => {
    const nested = z.object({ order: z.object({ value: schema }) });
    const found = problem(nested);
    expect(found.path).toBe("$.order.value");
    expect(found.reason).toContain(reason);
  });

  it("suggests portable alternatives", () => {
    expect(problem(z.date()).hint).toContain("z.iso.datetime()");
    expect(problem(z.map(z.string(), z.string())).hint).toContain("z.record()");
  });

  it("rejects non-Zod schemas", () => {
    const foreign: StandardSchemaV1 = { "~standard": { version: 1, vendor: "zod", validate: value => ({ value }) } };
    expect(problem(foreign).reason).toContain("not a Zod 4 schema");
  });

  it("rejects unknown Zod types instead of guessing", () => {
    const schema = z.string();
    const unknown = Object.assign(Object.create(Object.getPrototypeOf(schema) as object) as object, schema, { _zod: { ...schema._zod, def: { ...schema._zod.def, type: "future-type" } } }) as StandardSchemaV1;
    expect(problem(unknown).reason).toContain("future-type");
  });
});

describe("adapter identity", () => {
  it("records the vendor and the installed Zod version", () => {
    expect(zodAdapter.vendor).toBe("zod");
    expect(zodAdapter.library).toMatch(/^zod@4\.\d+\.\d+$/);
    expect(createZodAdapter({ library: "zod@4-custom" }).library).toBe("zod@4-custom");
  });

  it("recognizes Zod schemas structurally", () => {
    expect(isZodSchema(z.string())).toBe(true);
    expect(isZodSchema(zm.string())).toBe(true);
    expect(isZodSchema({ "~standard": { vendor: "zod" } })).toBe(false);
    expect(isZodSchema(null)).toBe(false);
  });
});