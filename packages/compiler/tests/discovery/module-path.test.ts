import {
  describe,
  expect,
  it
} from "bun:test";

import {
  compareCodeUnits,
  portableModulePath
} from "@/discovery/module-path";

describe("portableModulePath", () => {
  it.each([
    ["infra.ts", "infra.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["src\\orders\\a.ts", "src/orders/a.ts"],
    ["src//a.ts", "src/a.ts"]
  ])("normalizes %p to %p", (input, expected) => {
    expect(portableModulePath(input)).toBe(expected);
  });

  it.each(["", "/abs/a.ts", "C:\\app\\a.ts", "c:/a.ts", "../a.ts", "src/../a.ts", "src/./a.ts", "src/"])("rejects %p", (input) => {
    expect(portableModulePath(input)).toBeUndefined();
  });
});

describe("compareCodeUnits", () => {
  it("orders by UTF-16 code units, independent of locale", () => {
    expect(["b", "B", "a", "_"].sort(compareCodeUnits)).toEqual(["B", "_", "a", "b"]);
  });
});