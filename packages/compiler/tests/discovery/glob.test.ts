import {
  describe,
  expect,
  it
} from "bun:test";

import { compileGlob } from "@/discovery/glob";

describe("compileGlob", () => {
  it.each([
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/nested/a.ts", false],
    ["./handlers/*.ts", "handlers/place-order.ts", true],
    ["src/**/*.handler.ts", "src/a.handler.ts", true],
    ["src/**/*.handler.ts", "src/orders/deep/a.handler.ts", true],
    ["src/**/*.handler.ts", "src/orders/a.ts", false],
    ["src/**", "src/a/b/c.ts", true],
    ["**/*.ts", "a.ts", true],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["src/*.{ts,tsx}", "src/a.tsx", true],
    ["src/*.{ts,tsx}", "src/a.js", false],
    ["src/[a].ts", "src/[a].ts", true],
    ["src/[a].ts", "src/a.ts", false],
    ["src/a+b.ts", "src/a+b.ts", true],
    ["src/*.ts", "SRC/a.ts", false]
  ])("matches %p against %p: %p", (pattern, path, expected) => {
    expect(compileGlob(pattern).matches(path)).toBe(expected);
  });

  it("reports the pattern without a leading ./", () => {
    expect(compileGlob("./src/*.ts").pattern).toBe("src/*.ts");
  });
});