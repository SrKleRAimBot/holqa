import type { StandardSchemaV1 } from "@/standard-schema";

import {
  describe,
  expect,
  it
} from "bun:test";

import { errorCode } from "@/diagnostics";
import {
  InputValidationError,
  validateInput
} from "@/validation";

/** A hand-written asynchronous schema accepting positive numbers. */
const positive: StandardSchemaV1<number> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: async value => typeof value === "number" && value > 0
      ? { value }
      : { issues: [{ message: "Expected a positive number.", path: ["items", { key: 0 }, "count"] }] }
  }
};

describe("validateInput", () => {
  it("awaits asynchronous schemas and returns their output", async () => {
    expect(await validateInput(positive, 3, "count")).toBe(3);
  });

  it("throws an InputValidationError with normalized dotted paths", async () => {
    const error = await validateInput(positive, -1, "order line").then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(InputValidationError);
    expect(errorCode(error)).toBe("HOLQA_INPUT_INVALID");
    expect((error as InputValidationError).issues).toEqual([{ message: "Expected a positive number.", path: "items.0.count" }]);
  });
});