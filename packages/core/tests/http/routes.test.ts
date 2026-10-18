import type { HandlerDefinition } from "@/index";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  httpEndpoint,
  httpRouteKeys,
  joinRoutePath,
  routeShape
} from "@/http/routes";
import { parseResourceId } from "@/identity/resource-id";

/**
 * Builds a handler definition for an HTTP trigger.
 *
 * @param id - The handler identifier.
 * @param trigger - The trigger kind and options.
 * @returns A definition whose trigger belongs to the API or schedule "api".
 */
function definition(id: string, trigger: { readonly kind: "http.route"; readonly options: { readonly method: "GET" | "POST"; readonly path: string } } | { readonly kind: "http.procedure"; readonly options: { readonly operation: "query" | "mutation" } } | { readonly kind: "schedule.tick"; readonly options: Record<string, never> }): HandlerDefinition {
  const parsed = parseResourceId(id);
  const api = parseResourceId("api");
  if (!parsed.ok || !api.ok)
    throw new Error("invalid fixture identifier");
  return { id: parsed.value, trigger: { ...trigger, resource: { kind: trigger.kind === "schedule.tick" ? "schedule" : "http.api", id: api.value } } } as HandlerDefinition;
}

describe("route paths", () => {
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

describe("HTTP endpoints and route keys", () => {
  it("serves routes under the base path and procedures under the RPC mount", () => {
    expect(httpEndpoint("/api", definition("orders.get", { kind: "http.route", options: { method: "GET", path: "/orders/:id" } }))).toEqual({ path: "/api/orders/:id", methods: ["GET"] });
    expect(httpEndpoint("/", definition("orders.total", { kind: "http.procedure", options: { operation: "query" } }))).toEqual({ path: "/rpc/orders.total", methods: ["GET", "POST"] });
    expect(httpEndpoint("/api", definition("orders.cancel", { kind: "http.procedure", options: { operation: "mutation" } }))).toEqual({ path: "/api/rpc/orders.cancel", methods: ["POST"] });
    expect(httpEndpoint("/", definition("nightly", { kind: "schedule.tick", options: {} }))).toBeUndefined();
  });

  it("keys requests by method and shape, without the API", () => {
    expect(httpRouteKeys("/api", definition("orders.get", { kind: "http.route", options: { method: "GET", path: "/orders/:orderId" } }))).toEqual(["GET /api/orders/:"]);
    expect(httpRouteKeys("/api", definition("orders.total", { kind: "http.procedure", options: { operation: "query" } }))).toEqual(["GET /api/rpc/orders.total", "POST /api/rpc/orders.total"]);
    expect(httpRouteKeys("/", definition("nightly", { kind: "schedule.tick", options: {} }))).toEqual([]);
  });
});