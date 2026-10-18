import {
  describe,
  expect,
  it
} from "bun:test";

import {
  joinRoutePath,
  routeShape
} from "@/analysis/routes";

describe("routes", () => {
  it.each([
    ["/api", "/orders/:id", "/api/orders/:id"],
    ["/", "/", "/"],
    ["/", "/orders", "/orders"],
    ["/api", "/", "/api"]
  ])("joins %p and %p into %p", (basePath, path, expected) => {
    expect(joinRoutePath(basePath, path)).toBe(expected);
  });

  it("ignores parameter names but keeps static segments", () => {
    expect(routeShape("/orders/:orderId")).toBe(routeShape("/orders/:id"));
    expect(routeShape("/orders/new")).not.toBe(routeShape("/orders/:id"));
  });
});