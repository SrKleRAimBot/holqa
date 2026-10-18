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

import { isStandardSchema } from "@/schema/standard-schema";

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