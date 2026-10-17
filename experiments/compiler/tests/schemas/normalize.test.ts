import {
  describe,
  expect,
  it
} from "bun:test";

import {
  fingerprintSchema,
  normalizeJsonSchema
} from "@/schemas/normalize";

describe("normalizeJsonSchema", () => {
  it("removes $schema at every depth", () => {
    expect(normalizeJsonSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { a: { $schema: "x", type: "string" } }
    })).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("sorts and de-duplicates set-like keywords", () => {
    expect(normalizeJsonSchema({ required: ["b", "a", "b"], type: ["string", "null"] }))
      .toEqual({ required: ["a", "b"], type: ["null", "string"] });
  });

  it("keeps order-significant arrays in declaration order", () => {
    const schema = { enum: ["urgent", "normal"], prefixItems: [{ type: "string" }, { type: "number" }], anyOf: [{ type: "number" }, { type: "string" }] };
    expect(normalizeJsonSchema(schema)).toEqual(schema);
  });

  it("normalizes nested definitions", () => {
    expect(normalizeJsonSchema({ $defs: { Item: { required: ["z", "y"] } } })).toEqual({ $defs: { Item: { required: ["y", "z"] } } });
  });
});

describe("fingerprintSchema", () => {
  it("returns a sha256 digest that is independent of key order", async () => {
    const first = await fingerprintSchema({ type: "object", properties: { a: { type: "string" }, b: { type: "number" } } }, []);
    const second = await fingerprintSchema({ properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" }, []);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("changes when the schema or its runtime-only notes change", async () => {
    const base = await fingerprintSchema({ type: "string" }, []);
    expect(await fingerprintSchema({ type: "string", minLength: 1 }, [])).not.toBe(base);
    expect(await fingerprintSchema({ type: "string" }, ["refinement at $"])).not.toBe(base);
  });
});