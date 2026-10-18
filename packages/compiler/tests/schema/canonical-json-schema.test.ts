import {
  describe,
  expect,
  it
} from "bun:test";

import { canonicalJsonStringify } from "@/manifest/canonical-json";
import { canonicalizeJsonSchema } from "@/schema/canonical-json-schema";

describe("canonicalizeJsonSchema", () => {
  it("removes the top-level $schema keyword", () => {
    expect(canonicalizeJsonSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" })).toEqual({ type: "string" });
  });

  it("sorts and de-duplicates set-like keywords at every depth", () => {
    const schema = canonicalizeJsonSchema({
      type: "object",
      required: ["b", "a", "b"],
      properties: {
        kind: { enum: ["urgent", "normal", "urgent"] },
        value: { type: ["null", "string", "null"] },
        choice: { anyOf: [{ type: "string" }, { type: "number" }] },
        list: { type: "array", items: { type: ["integer"] } },
        tuple: { prefixItems: [{ type: "string" }, { type: "boolean" }] }
      }
    });
    expect(schema).toEqual({
      type: "object",
      required: ["a", "b"],
      properties: {
        kind: { enum: ["normal", "urgent"] },
        value: { type: ["null", "string"] },
        choice: { anyOf: [{ type: "number" }, { type: "string" }] },
        list: { type: "array", items: { type: "integer" } },
        tuple: { prefixItems: [{ type: "string" }, { type: "boolean" }] }
      }
    });
  });

  it("makes declaration order irrelevant to canonical JSON", () => {
    const left = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a", "b"] };
    const right = { required: ["b", "a"], properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" };
    expect(canonicalJsonStringify(canonicalizeJsonSchema(left))).toBe(canonicalJsonStringify(canonicalizeJsonSchema(right)));
  });

  it("never reorders data-valued keywords or tuple positions", () => {
    const schema = { const: ["b", "a"], default: ["b", "a"], examples: [2, 1], prefixItems: [{ const: 2 }, { const: 1 }] };
    expect(canonicalizeJsonSchema(schema)).toEqual(schema);
  });

  it("keeps list order when a $ref points into a set-like list", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }], properties: { x: { $ref: "#/anyOf/0" } } };
    expect(canonicalizeJsonSchema(schema)).toEqual(schema);
  });

  it("canonicalizes inside $defs and additionalProperties", () => {
    expect(canonicalizeJsonSchema({ $defs: { a: { required: ["y", "x"] } }, additionalProperties: { enum: [2, 1] } })).toEqual({ $defs: { a: { required: ["x", "y"] } }, additionalProperties: { enum: [1, 2] } });
  });

  it("is idempotent", () => {
    const once = canonicalizeJsonSchema({ type: ["string", "null"], enum: ["b", "a", null] });
    expect(canonicalizeJsonSchema(once)).toEqual(once);
  });
});