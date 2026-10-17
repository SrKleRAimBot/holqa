import {
  describe,
  expect,
  it
} from "bun:test";

import { isJsonValue } from "@/json";

describe("isJsonValue", () => {
  it("accepts plain JSON data", () => {
    expect(isJsonValue({ a: [1, "b", null, true, { c: Object.create(null) as object }] })).toBe(true);
  });

  it("rejects values without a lossless JSON form", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, () => 1, new Date(0), new Map(), 1n, { a: undefined }])
      expect(isJsonValue(value)).toBe(false);
  });
});