import type { StandardSchemaV1 } from "@/schema/standard-schema";

import { rejectionOf } from "@test/support/rejection";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import { HolqaError } from "@/errors/holqa-error";
import {
  InputValidationError,
  normalizeIssue,
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
    expect(failure.issues).toEqual([
      { message: "Expected a string.", path: "lines.0.Symbol(sku)", segments: ["lines", 0, "Symbol(sku)"], pointer: "/lines/0/Symbol(sku)" },
      { message: "Also wrong.", path: "", segments: [], pointer: "" }
    ]);
    expect(failure.message).toBe("error HOLQA_INPUT_INVALID: Invalid message for queue \"orders\": lines.0.Symbol(sku): Expected a string.; Also wrong.");
    expect(failure.message).not.toContain("do-not-log");
  });
});

describe("structured validation issues", () => {
  it("lists every failing field in the diagnostic details", async () => {
    const error = await rejectionOf<InputValidationError>(validateInput(trimmed, 1, "request body"));
    const diagnostic = error.diagnostics[0]!;
    expect(diagnostic.details).toEqual({
      subject: "request body",
      issues: [
        { path: "lines.0.Symbol(sku)", pointer: "/lines/0/Symbol(sku)", segments: ["lines", 0, "Symbol(sku)"], message: "Expected a string." },
        { path: "", pointer: "", segments: [], message: "Also wrong." }
      ]
    });
  });

  it("keeps scalar library details but never the rejected input", () => {
    const issue = normalizeIssue({
      message: "Too small",
      path: ["a/b", "c~d"],
      ...{ code: "too_small", minimum: 1, inclusive: true, values: ["x", "y"], input: "secret", nested: { deep: true }, check: () => true }
    });
    expect(issue).toEqual({
      message: "Too small",
      path: "a/b.c~d",
      segments: ["a/b", "c~d"],
      pointer: "/a~1b/c~0d",
      details: { code: "too_small", minimum: 1, inclusive: true, values: ["x", "y"] }
    });
  });

  it("omits details when the library reports none", () => {
    expect("details" in normalizeIssue({ message: "Bad" })).toBe(false);
  });

  it("accepts issues in the original two-field form and derives the other path forms", () => {
    const error = new InputValidationError("value", [{ message: "Bad", path: "lines.0.sku" }]);
    expect(error.issues).toEqual([{ message: "Bad", path: "lines.0.sku", segments: ["lines", 0, "sku"], pointer: "/lines/0/sku" }]);
    expect(Object.isFrozen(error.issues[0])).toBe(true);
  });
});