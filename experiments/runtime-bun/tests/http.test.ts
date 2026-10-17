import type {
  HandlerInfo,
  ResourceInfo
} from "@/generation/registry";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  matchRoute,
  routeTable
} from "@/http";

/**
 * Creates route handler metadata.
 *
 * @param id - The handler identifier.
 * @param method - The HTTP method.
 * @param path - The route path relative to the API base path.
 * @returns The handler metadata.
 */
function route(id: string, method: string, path: string): [string, HandlerInfo] {
  return [id, { id, trigger: { kind: "http.route", resource: "api", method, path }, config: {}, module: "x.ts" }];
}

const resources = new Map<string, ResourceInfo>([["api", { id: "api", kind: "http.api", config: { basePath: "/api/" } }]]);
const table = routeTable(new Map([route("by-id", "GET", "/orders/:id"), route("latest", "GET", "/orders/latest"), route("create", "POST", "/orders")]), resources);

describe("routeTable and matchRoute", () => {
  it("prefers static segments and decodes parameters", () => {
    expect(matchRoute(table, "GET", "/api/orders/latest")).toMatchObject({ kind: "matched", route: { handlerId: "latest" } });
    expect(matchRoute(table, "GET", "/api/orders/a%20b")).toMatchObject({ kind: "matched", params: { id: "a b" } });
  });

  it("distinguishes a method mismatch from a missing route", () => {
    expect(matchRoute(table, "DELETE", "/api/orders")).toEqual({ kind: "method-not-allowed", allowed: ["POST"] });
    expect(matchRoute(table, "GET", "/api/customers")).toEqual({ kind: "not-found" });
  });
});