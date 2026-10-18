import {
  describe,
  expect,
  it
} from "bun:test";

import { validateJsonSchema } from "@/validation/json-schema-validator";

describe("validateJsonSchema", () => {
  const schema = {
    $defs: { id: { type: "string", pattern: "^[a-z]+$", maxLength: 5 } },
    type: "object",
    additionalProperties: false,
    required: ["id", "count"],
    properties: {
      id: { $ref: "#/$defs/id" },
      count: { type: "integer", minimum: 1 },
      tags: { type: "array", uniqueItems: true, minItems: 1, items: { enum: ["a", "b"] } },
      kind: { oneOf: [{ const: "x" }, { const: "y" }] },
      map: { type: "object", propertyNames: { pattern: "^k" }, additionalProperties: { type: "boolean" } }
    }
  };

  it("accepts a valid value", () => {
    expect(validateJsonSchema(schema, { id: "abc", count: 2, tags: ["a", "b"], kind: "y", map: { k1: true } })).toEqual([]);
  });

  it("reports every violation with its JSON path", () => {
    expect(validateJsonSchema(schema, { id: "ABCDEFG", count: 0.5, tags: ["a", "a", "c"], kind: "z", map: { x: true, k2: 1 }, extra: 1 })).toEqual([
      { path: "$.id", message: "must have at most 5 characters" },
      { path: "$.id", message: "must match ^[a-z]+$" },
      { path: "$.count", message: "must be of type integer" },
      { path: "$.tags", message: "must not contain duplicate items" },
      { path: "$.tags[2]", message: "must be one of \"a\", \"b\"" },
      { path: "$.kind", message: "must be \"x\"" },
      { path: "$.map.x", message: "must match ^k" },
      { path: "$.map.k2", message: "must be of type boolean" },
      { path: "$.extra", message: "is not an allowed property" }
    ]);
    expect(validateJsonSchema(schema, {})).toEqual([
      { path: "$", message: "must have the property \"id\"" },
      { path: "$", message: "must have the property \"count\"" }
    ]);
  });

  it("distinguishes arrays, null and objects", () => {
    expect(validateJsonSchema({ type: "object" }, [])).toHaveLength(1);
    expect(validateJsonSchema({ type: "object" }, null)).toHaveLength(1);
    expect(validateJsonSchema({ type: "null" }, null)).toEqual([]);
  });

  it("rejects values matching several oneOf alternatives", () => {
    expect(validateJsonSchema({ oneOf: [{ type: "string" }, { minLength: 1 }] }, "a")).toEqual([{ path: "$", message: "must match exactly one alternative, but matches several" }]);
  });

  it("throws on keywords and references it does not implement", () => {
    expect(() => validateJsonSchema({ anyOf: [] }, 1)).toThrow("Unsupported JSON Schema keyword \"anyOf\"");
    expect(() => validateJsonSchema({ $ref: "#/$defs/missing" }, 1)).toThrow("Unresolvable");
  });
});