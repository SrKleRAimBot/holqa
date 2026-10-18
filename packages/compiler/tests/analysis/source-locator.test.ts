import {
  describe,
  expect,
  it
} from "bun:test";

import { SourceLocator } from "@/analysis/source-locator";

describe("SourceLocator", () => {
  const locator = new SourceLocator({
    "lib/orders.ts": "queue({ id: \"orders\" })",
    "infra.ts": "const x = 1;\nexport const api = http.api({ id: 'shop-api' });\nqueue({ id: `orders` });"
  }, "infra.ts");

  it("finds quoted literals, preferring the application module", () => {
    expect(locator.locate("shop-api", "infra.ts")).toEqual({ file: "infra.ts", line: 2, column: 35 });
    expect(locator.locate("orders", "infra.ts")).toEqual({ file: "infra.ts", line: 3, column: 13 });
  });

  it("does not match identifiers inside longer literals", () => {
    expect(locator.locate("shop", "infra.ts")).toEqual({ file: "infra.ts" });
  });

  it("searches only the given file when asked", () => {
    expect(locator.locate("orders", "lib/orders.ts", "lib/orders.ts")).toEqual({ file: "lib/orders.ts", line: 1, column: 13 });
    expect(locator.locate("shop-api", "lib/orders.ts", "lib/orders.ts")).toEqual({ file: "lib/orders.ts" });
  });

  it("escapes regular-expression characters in identifiers", () => {
    expect(new SourceLocator({ "a.ts": "\"ordersXprocess\"" }, "a.ts").locate("orders.process", "a.ts")).toEqual({ file: "a.ts" });
  });
});