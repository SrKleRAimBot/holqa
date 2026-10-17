import {
  describe,
  expect,
  it
} from "bun:test";

import {
  hasStandardJsonSchema,
  isStandardSchema
} from "@/standard-schema";

describe("Standard Schema guards", () => {
  /** A schema-like value whose validate function is never called. */
  const schema = { "~standard": { version: 1, vendor: "test", validate: () => ({ value: 1 }) } };

  it("recognizes Standard Schemas structurally and rejects look-alikes", () => {
    expect(isStandardSchema(schema)).toBe(true);
    expect(isStandardSchema({ "~standard": { version: 2, vendor: "test", validate: () => ({ value: 1 }) } })).toBe(false);
    expect(isStandardSchema({ parse: () => 1 })).toBe(false);
    expect(isStandardSchema(undefined)).toBe(false);
  });

  it("detects the Standard JSON Schema converter only when both sides are functions", () => {
    expect(hasStandardJsonSchema(schema as never)).toBe(false);
    const converter = { input: () => ({}), output: () => ({}) };
    expect(hasStandardJsonSchema({ "~standard": { ...schema["~standard"], jsonSchema: converter } } as never)).toBe(true);
    expect(hasStandardJsonSchema({ "~standard": { ...schema["~standard"], jsonSchema: { input: () => ({}) } } } as never)).toBe(false);
  });
});