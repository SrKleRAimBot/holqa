import {
  describe,
  expect,
  it
} from "bun:test";

import { checkObjectKey } from "@/storage/object-key";

describe("checkObjectKey", () => {
  it.each([["a"], ["incoming/2026/report.pdf"], ["with space and ünïcode"], ["a//b"], ["x".repeat(1024)]])("accepts %p", (key) => {
    expect(checkObjectKey(key, "put")).toBeUndefined();
  });

  it.each([
    [""],
    ["/leading"],
    ["a/../b"],
    ["./a"],
    ["a/."],
    ["tab\there"],
    ["nul\u0000"],
    ["é".repeat(513)],
    [42]
  ])("rejects %p with HOLQA_OBJECT_KEY_INVALID", (key) => {
    expect(checkObjectKey(key, "bucket \"uploads\" put")?.code).toBe("HOLQA_OBJECT_KEY_INVALID");
  });
});