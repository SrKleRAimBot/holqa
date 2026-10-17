import {
  describe,
  expect,
  it
} from "bun:test";

import {
  joinRoutePath,
  routeShape
} from "@/graph/routes";

describe("joinRoutePath", () => {
  it.each([
    ["/api", "/orders", "/api/orders"],
    ["/api/", "orders/", "/api/orders"],
    ["", "/", "/"],
    ["/", "/orders/:orderId", "/orders/:orderId"]
  ])("joins %p and %p", (basePath, path, expected) => {
    expect(joinRoutePath(basePath, path)).toBe(expected);
  });
});

describe("routeShape", () => {
  it("erases parameter names but keeps static segments", () => {
    expect(routeShape("/api/orders/:orderId")).toBe(routeShape("/api/orders/:id"));
    expect(routeShape("/api/orders/new")).not.toBe(routeShape("/api/orders/:id"));
  });
});