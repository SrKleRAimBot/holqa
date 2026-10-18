import type {
  JsonObject,
  JsonValue
} from "@holqa/core";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  deepEqual,
  findRejections
} from "@/schema/json-schema-acceptance";

/**
 * Summarizes findings as `kind certainty path` strings.
 *
 * @param reader - The reading schema.
 * @param writer - The writing schema.
 * @returns The summaries.
 */
function rejections(reader: JsonValue, writer: JsonValue): string[] {
  return findRejections(reader, writer).map(finding => `${finding.kind} ${finding.certainty} ${finding.path}`);
}

/**
 * Wraps a property schema in an object with one required property `x`.
 *
 * @param property - The property schema.
 * @returns The object schema.
 */
function field(property: JsonObject): JsonObject {
  return { type: "object", properties: { x: property }, required: ["x"] };
}

describe("findRejections: accepted changes", () => {
  it.each<[string, JsonValue, JsonValue]>([
    ["identical schemas", { type: "string" }, { type: "string" }],
    ["an unconstrained reader", {}, { type: "string" }],
    ["a boolean true reader", true, { type: "number" }],
    ["a writer that accepts nothing", { type: "string" }, false],
    ["annotation-only differences", { type: "string", description: "new" }, { type: "string", title: "old" }],
    ["an added optional property", { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] }, { type: "object", properties: { a: { type: "string" } }, required: ["a"] }],
    ["a removed property on a non-strict reader", { type: "object", properties: {} }, { type: "object", properties: { a: { type: "string" } } }],
    ["a required property made optional", { type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { a: { type: "string" } }, required: ["a"] }],
    ["integers read as numbers", { type: "number" }, { type: "integer" }],
    ["a widened type", { type: ["number", "string"] }, { type: "string" }],
    ["an added enum value", { enum: ["a", "b", "c"] }, { enum: ["a", "b"] }],
    ["relaxed bounds", { type: "number", minimum: 0, maximum: 100 }, { type: "number", minimum: 1, exclusiveMaximum: 50 }],
    ["relaxed lengths", { type: "string", maxLength: 10 }, { type: "string", minLength: 1, maxLength: 5 }],
    ["a removed pattern and format", { type: "string" }, { type: "string", pattern: "^a", format: "email" }],
    ["a compatible multipleOf", { type: "number", multipleOf: 2 }, { type: "number", multipleOf: 4 }],
    ["integers with multipleOf 1", { type: "number", multipleOf: 1 }, { type: "integer" }],
    ["a writer union covered by the reader", { type: ["number", "string"] }, { anyOf: [{ type: "string" }, { type: "number" }] }],
    ["a writer with several types matched by reader members", { anyOf: [{ type: "string" }, { type: "number" }] }, { type: ["number", "string"] }],
    ["a nullable field that stays nullable", { type: ["null", "string"] }, { type: "null" }],
    ["enum values that satisfy the reader's constraints", { type: "string", minLength: 1, pattern: "^[a-z]+$" }, { enum: ["normal", "urgent"] }],
    ["array items widened", { type: "array", items: { type: ["number", "string"] } }, { type: "array", items: { type: "string" } }],
    ["writer-only narrowing keywords", { type: "array" }, { type: "array", uniqueItems: true }],
    ["identical unanalyzed keywords", { allOf: [{ type: "string" }] }, { allOf: [{ type: "string" }] }],
    ["a record that keeps its value type", { type: "object", additionalProperties: { type: "number" } }, { type: "object", additionalProperties: { type: "integer" } }]
  ])("accepts %s", (_name, reader, writer) => {
    expect(rejections(reader, writer)).toEqual([]);
  });
});

describe("findRejections: narrowing changes", () => {
  it.each<[string, JsonValue, JsonValue, string[]]>([
    ["a narrowed type", field({ type: "integer" }), field({ type: "number" }), ["type-narrowed definite $.x"]],
    ["a type that changed", field({ type: "string" }), field({ type: "number" }), ["type-narrowed definite $.x"]],
    ["a type added where any value was allowed", field({ type: "string" }), field({}), ["type-narrowed definite $.x"]],
    ["a removed enum value", field({ enum: ["normal"] }), field({ enum: ["normal", "urgent"] }), ["enum-value-removed definite $.x"]],
    ["an enum restricting a free string", field({ enum: ["a"] }), field({ type: "string" }), ["value-restricted definite $.x"]],
    ["a raised minimum", field({ type: "number", minimum: 5 }), field({ type: "number", minimum: 1 }), ["constraint-tightened definite $.x"]],
    ["an exclusive minimum at the old inclusive bound", field({ type: "number", exclusiveMinimum: 1 }), field({ type: "number", minimum: 1 }), ["constraint-tightened definite $.x"]],
    ["an added maximum", field({ type: "number", maximum: 10 }), field({ type: "number" }), ["constraint-tightened definite $.x"]],
    ["a lowered maxLength", field({ type: "string", maxLength: 3 }), field({ type: "string", maxLength: 5 }), ["constraint-tightened definite $.x"]],
    ["an added minItems", field({ type: "array", minItems: 1 }), field({ type: "array" }), ["constraint-tightened definite $.x"]],
    ["an incompatible multipleOf", field({ type: "number", multipleOf: 3 }), field({ type: "number", multipleOf: 2 }), ["constraint-tightened definite $.x"]],
    ["an added pattern", field({ type: "string", pattern: "^SKU-" }), field({ type: "string" }), ["pattern-changed definite $.x"]],
    ["a changed pattern", field({ type: "string", pattern: "^b" }), field({ type: "string", pattern: "^a" }), ["pattern-changed possible $.x"]],
    ["an added format", field({ type: "string", format: "email" }), field({ type: "string" }), ["format-changed definite $.x"]],
    ["a changed format", field({ type: "string", format: "date" }), field({ type: "string", format: "date-time" }), ["format-changed possible $.x"]],
    ["an enum value the reader's pattern rejects", field({ type: "string", pattern: "^[a-z]+$" }), field({ enum: ["A"] }), ["pattern-changed definite $.x"]],
    ["an enum value below the reader's minimum", field({ type: "integer", minimum: 2 }), field({ enum: [1, 2] }), ["constraint-tightened definite $.x"]],
    ["an added required property", { type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object" }, ["required-property-added definite $.a"]],
    ["an optional property made required", { type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object", properties: { a: { type: "string" } } }, ["optional-became-required definite $.a"]],
    ["a property removed from a strict reader", { type: "object", properties: {}, additionalProperties: false }, { type: "object", properties: { a: { type: "string" } }, additionalProperties: false }, ["property-removed definite $.a"]],
    ["a reader that became strict", { type: "object", properties: { a: { type: "string" } }, additionalProperties: false }, { type: "object", properties: { a: { type: "string" } } }, ["additional-properties-restricted possible $.*"]],
    ["a narrowed record value", { type: "object", additionalProperties: { type: "integer" } }, { type: "object", additionalProperties: { type: "number" } }, ["type-narrowed definite $.*"]],
    ["a narrowed nested array item", field({ type: "array", items: { type: "object", properties: { sku: { type: "string", minLength: 3 } } } }), field({ type: "array", items: { type: "object", properties: { sku: { type: "string" } } } }), ["constraint-tightened definite $.x[*].sku"]],
    ["a narrowed tuple position", field({ type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false }), field({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false }), ["type-narrowed definite $.x[1]"]],
    ["a shorter tuple", field({ type: "array", prefixItems: [{ type: "string" }], items: false }), field({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false }), ["value-rejected definite $.x[1]"]],
    ["a removed union member", field({ anyOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }] }), field({ anyOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object", properties: { b: { type: "number" } }, required: ["b"] }] }), ["required-property-added definite $.x.a"]],
    ["nullability removed", field({ type: "string" }), field({ type: ["null", "string"] }), ["type-narrowed definite $.x"]],
    ["a oneOf discriminated union with disjoint members", { oneOf: [{ type: "object", properties: { kind: { const: "a" } }, required: ["kind"] }, { type: "object", properties: { kind: { const: "b" } }, required: ["kind"] }] }, { type: "object", properties: { kind: { const: "a" } }, required: ["kind"] }, []],
    ["a discriminated union member removed", { oneOf: [{ type: "object", properties: { kind: { const: "card" } }, required: ["kind"] }] }, { oneOf: [{ type: "object", properties: { kind: { const: "card" } }, required: ["kind"] }, { type: "object", properties: { kind: { const: "bank" } }, required: ["kind"] }] }, ["enum-value-removed definite $.kind"]],
    ["a reader that rejects everything", false, { type: "string" }, ["value-rejected definite $"]],
    ["a changed unanalyzed keyword", { allOf: [{ type: "string" }, { minLength: 1 }] }, { allOf: [{ type: "string" }] }, ["unsupported-keyword unknown $"]],
    ["a writer reference the checker cannot follow", { type: "object" }, { $ref: "#/$defs/order" }, ["unsupported-keyword unknown $"]],
    ["a reader-only narrowing keyword", { type: "array", uniqueItems: true }, { type: "array" }, ["unsupported-keyword unknown $"]],
    ["a oneOf whose members overlap", { oneOf: [{ type: "string" }, { type: "string", minLength: 1 }] }, { type: "string" }, ["value-rejected possible $"]],
    ["anyOf combined with oneOf", { anyOf: [{ type: "string" }], oneOf: [{ type: "string" }] }, { type: "string" }, ["unsupported-keyword unknown $"]],
    ["removed patternProperties", { type: "object", additionalProperties: false }, { type: "object", patternProperties: { "^x-": { type: "string" } }, additionalProperties: false }, ["unsupported-keyword unknown $"]],
    ["an object const", { type: "object", properties: { b: { type: "number" } }, required: ["b"] }, { const: { a: 1 } }, ["unsupported-keyword unknown $"]],
    ["an array const", { type: "array", minItems: 2 }, { const: [1] }, ["unsupported-keyword unknown $"]]
  ])("reports %s", (_name, reader, writer, expected) => {
    expect(rejections(reader, writer)).toEqual(expected);
  });

  it("quotes non-identifier keys in paths", () => {
    expect(findRejections({ type: "object", properties: { "unit price": { type: "integer" } } }, { type: "object", properties: { "unit price": { type: "number" } } })[0]!.path).toBe("$[\"unit price\"]");
  });

  it("records the constraints on both sides", () => {
    expect(findRejections({ type: "number", minimum: 5 }, { type: "number", minimum: 1 })[0]).toEqual({ path: "$", kind: "constraint-tightened", certainty: "definite", reader: ">= 5", writer: ">= 1" });
  });
});

describe("deepEqual", () => {
  it("ignores key order and compares arrays by position", () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});