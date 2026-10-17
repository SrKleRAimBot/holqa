import type { Result } from "@/result";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  err,
  ok
} from "@/result";

/**
 * Parses a decimal integer, returning a failure for non-numeric input.
 *
 * @param input - The text to parse.
 * @returns The parsed integer, or an error message.
 */
function parseNumber(input: string): Result<number, string> {
  const value = Number.parseInt(input, 10);
  return Number.isNaN(value) ? err(`"${input}" is not a number`) : ok(value);
}

describe("result", () => {
  it("creates frozen success values", () => {
    const result = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("creates frozen failure values", () => {
    const result = err("boom");
    expect(result).toEqual({ ok: false, error: "boom" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("narrows on the ok discriminant", () => {
    const result = parseNumber("1");
    if (result.ok)
      expectTypeOf(result.value).toEqualTypeOf<number>();
    else
      expectTypeOf(result.error).toEqualTypeOf<string>();

    // @ts-expect-error `value` is not accessible before narrowing.
    expect(result.value).toBe(1);
  });
});