import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import { createDiagnostic } from "@/diagnostics/diagnostic";
import {
  diagnosticsOf,
  failWith,
  HolqaError,
  isHolqaError
} from "@/errors/holqa-error";

/** A diagnostic used by several tests. */
const duplicate = createDiagnostic({ code: "HOLQA_RESOURCE_ID_DUPLICATE", severity: "error", message: "Duplicate.", hint: "Rename one." });

describe("HolqaError", () => {
  it("carries every diagnostic and lists them in its message", () => {
    const invalid = createDiagnostic({ code: "HOLQA_RESOURCE_ID_INVALID", severity: "error", message: "Invalid." });
    const error = new HolqaError([duplicate, invalid]);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("HolqaError");
    expect(error.code).toBe("HOLQA_RESOURCE_ID_DUPLICATE");
    expect(error.diagnostics).toEqual([duplicate, invalid]);
    expect(Object.isFrozen(error.diagnostics)).toBe(true);
    expect(error.message).toBe("error HOLQA_RESOURCE_ID_DUPLICATE: Duplicate.\n  hint: Rename one.\nerror HOLQA_RESOURCE_ID_INVALID: Invalid.");
  });

  it("accepts a single diagnostic and keeps the cause", () => {
    const cause = new Error("root");
    const error = new HolqaError(duplicate, { cause });
    expect(error.diagnostics).toEqual([duplicate]);
    expect(error.cause).toBe(cause);
  });

  it("requires at least one diagnostic", () => {
    expect(() => new HolqaError([])).toThrow(RangeError);
  });
});

describe("failWith", () => {
  it("throws an error-severity diagnostic", () => {
    let caught: unknown;
    try {
      failWith("HOLQA_RUNTIME_NOT_BOUND", "Not bound.", "Bind it.");
    } catch (error) {
      caught = error;
    }
    expect(diagnosticsOf(caught)).toEqual([{ code: "HOLQA_RUNTIME_NOT_BOUND", severity: "error", message: "Not bound.", hint: "Bind it." }]);
    expectTypeOf(failWith).returns.toEqualTypeOf<never>();
  });
});

describe("structural recognition", () => {
  it("recognizes errors from another copy of the package by shape", () => {
    const foreign = Object.assign(new Error("x"), { diagnostics: [{ code: "HOLQA_INPUT_INVALID", severity: "error", message: "x" }] });
    expect(isHolqaError(foreign)).toBe(true);
    expect(diagnosticsOf(foreign).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_INPUT_INVALID"]);
  });

  it.each([undefined, "text", new Error("plain"), { diagnostics: "nope" }, Object.assign(new Error("x"), { diagnostics: [{ code: 1 }] })])("ignores non-Holqa value #%#", (value) => {
    expect(isHolqaError(value)).toBe(false);
    expect(diagnosticsOf(value)).toEqual([]);
  });
});