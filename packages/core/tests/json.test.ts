import {
  describe,
  expect,
  it
} from "bun:test";

import { isJsonValue } from "@/json";

describe("isJsonValue", () => {
  // Values are wrapped in objects because it.each spreads array rows into arguments.
  it.each([null, true, 0, -1.5, "text", [], [1, "a", null], {}, { a: { b: [1] } }, Object.create(null) as object].map(value => ({ value })))("accepts %p", ({ value }) => {
    expect(isJsonValue(value)).toBe(true);
  });

  it.each([undefined, Number.NaN, Infinity, 1n, Symbol("s"), () => 1, new Date(0), new Map(), [undefined], { a: undefined }].map(value => ({ value })))("rejects %p", ({ value }) => {
    expect(isJsonValue(value)).toBe(false);
  });

  it("rejects circular structures without overflowing the stack", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(isJsonValue(cycle)).toBe(false);
  });

  it("accepts the same object referenced twice when there is no cycle", () => {
    const shared = { a: 1 };
    expect(isJsonValue({ left: shared, right: shared })).toBe(true);
  });
});