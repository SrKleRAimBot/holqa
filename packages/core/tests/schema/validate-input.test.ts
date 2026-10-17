import type { StandardSchemaV1 } from "@/schema/standard-schema";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import { HolqaError } from "@/errors/holqa-error";
import {
  InputValidationError,
  validateInput
} from "@/schema/validate-input";

/** An asynchronous schema that trims strings and reports nested paths. */
const trimmed: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: async value => typeof value === "string"
      ? { value: value.trim() }
      : { issues: [{ message: "Expected a string.", path: ["lines", { key: 0 }, Symbol.for("sku")] }, { message: "Also wrong." }] }
  }
};

describe("validateInput", () => {
  it("awaits asynchronous schemas and returns the output", async () => {
    const value = await validateInput(trimmed, "  a  ", "test value");
    expectTypeOf(value).toEqualTypeOf<string>();
    expect(value).toBe("a");
  });

  it("throws HOLQA_INPUT_INVALID with normalized paths and without echoing the value", async () => {
    const error = await validateInput(trimmed, { secret: "do-not-log" }, "message for queue \"orders\"").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toBeInstanceOf(HolqaError);
    const failure = error as InputValidationError;
    expect(failure.code).toBe("HOLQA_INPUT_INVALID");
    expect(failure.issues).toEqual([{ message: "Expected a string.", path: "lines.0.Symbol(sku)" }, { message: "Also wrong.", path: "" }]);
    expect(failure.message).toBe("error HOLQA_INPUT_INVALID: Invalid message for queue \"orders\": lines.0.Symbol(sku): Expected a string.; Also wrong.");
    expect(failure.message).not.toContain("do-not-log");
  });
});