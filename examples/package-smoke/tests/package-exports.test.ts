import type {
  Diagnostic,
  ResourceId
} from "@holqa/core";

import { canonicalJsonStringify } from "@holqa/compiler";
import { parseResourceId } from "@holqa/core";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

describe("@holqa/core public exports", () => {
  it("validates resource identifiers through the built package", () => {
    const result = parseResourceId("order-processing");
    expect(result.ok).toBe(true);
    if (result.ok)
      expectTypeOf(result.value).toEqualTypeOf<ResourceId>();
    else
      expectTypeOf(result.error).toEqualTypeOf<Diagnostic>();
  });
});

describe("@holqa/compiler public exports", () => {
  it("serializes deterministically through the built package", () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe("{\n  \"a\": 2,\n  \"b\": 1\n}");
  });
});