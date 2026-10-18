import type {
  InferInput,
  InferOutput,
  StandardSchemaV1
} from "@/schema/standard-schema";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  hasStandardJsonSchema,
  isStandardSchema
} from "@/schema/standard-schema";

/** A schema whose input is a string and whose output is a number. */
const parsedNumber: StandardSchemaV1<string, number> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: value => typeof value === "string" ? { value: Number(value) } : { issues: [{ message: "Expected a string." }] }
  }
};

describe("Standard Schema types", () => {
  it("infer the input and output sides separately", () => {
    expectTypeOf<InferInput<typeof parsedNumber>>().toEqualTypeOf<string>();
    expectTypeOf<InferOutput<typeof parsedNumber>>().toEqualTypeOf<number>();
  });

  it("reject values without a ~standard property", () => {
    // @ts-expect-error -- a parse function alone is not a Standard Schema.
    const notASchema: StandardSchemaV1 = { parse: (value: unknown) => value };
    expect(isStandardSchema(notASchema)).toBe(false);
  });
});

describe("isStandardSchema", () => {
  it("accepts objects and functions that implement version 1", () => {
    expect(isStandardSchema(parsedNumber)).toBe(true);
    expect(isStandardSchema(Object.assign(() => {}, { "~standard": parsedNumber["~standard"] }))).toBe(true);
  });

  it.each([
    null,
    "schema",
    {},
    { "~standard": null },
    { "~standard": { version: 2, vendor: "x", validate: () => ({ value: 1 }) } },
    { "~standard": { version: 1, validate: () => ({ value: 1 }) } },
    { "~standard": { version: 1, vendor: "x" } }
  ])("rejects %p", (value) => {
    expect(isStandardSchema(value)).toBe(false);
  });
});

describe("hasStandardJsonSchema", () => {
  it("requires input and output converters", () => {
    const converter = { input: () => ({ type: "string" }), output: () => ({ type: "string" }) };
    const base = parsedNumber["~standard"];
    /**
     * Builds a candidate schema with the given `jsonSchema` property. Only the structure matters to the guard.
     *
     * @param jsonSchema - The value placed under `~standard.jsonSchema`.
     * @returns The candidate, typed as a Standard Schema.
     */
    const withConverter = (jsonSchema: unknown) => ({ "~standard": { ...base, jsonSchema } }) as unknown as StandardSchemaV1;
    expect(hasStandardJsonSchema(withConverter(converter))).toBe(true);
    expect(hasStandardJsonSchema(parsedNumber)).toBe(false);
    expect(hasStandardJsonSchema(withConverter({ input: converter.input }))).toBe(false);
    expect(hasStandardJsonSchema(withConverter(null))).toBe(false);
  });

  it("keeps the schema's input and output types when it narrows", () => {
    const candidate: StandardSchemaV1<string, number> = parsedNumber;
    if (hasStandardJsonSchema(candidate)) {
      expectTypeOf<InferInput<typeof candidate>>().toEqualTypeOf<string>();
      expectTypeOf<InferOutput<typeof candidate>>().toEqualTypeOf<number>();
    }
  });
});