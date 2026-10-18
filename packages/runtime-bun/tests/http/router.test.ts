import {
  apiResource,
  application,
  procedureHandler,
  routeHandler
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  buildRouteTable,
  matchRoute
} from "@/http/router";

/**
 * Builds a route table from handler registrations.
 *
 * @param basePath - The API's base path.
 * @param handlers - Handler registrations.
 * @returns The table and its problems.
 */
function tableOf(basePath: string, ...handlers: ReadonlyArray<ReturnType<typeof routeHandler>>): ReturnType<typeof buildRouteTable> {
  return buildRouteTable(application([apiResource("api", basePath)])["~holqa"], handlers.map(handler => handler["~holqa"].definition));
}

describe("buildRouteTable", () => {
  it("joins base paths, mounts procedures under rpc and records their methods", () => {
    const { table, problems } = tableOf("/", routeHandler("orders.get", "api", "GET", "/orders/:id"), procedureHandler("orders.total", "api", "query"), procedureHandler("orders.cancel", "api", "mutation"));
    expect(problems).toEqual([]);
    expect(table.entries.map(entry => [entry.handlerId, entry.path, entry.methods, entry.transport])).toEqual([
      ["orders.cancel", "/rpc/orders.cancel", ["POST"], "rpc"],
      ["orders.total", "/rpc/orders.total", ["GET", "POST"], "rpc"],
      ["orders.get", "/orders/:id", ["GET"], "http"]
    ]);
    expect(table.rpcMounts).toEqual([["rpc"]]);
  });

  it("reports handlers that serve the same method and shape", () => {
    const { problems } = tableOf("/api", routeHandler("a", "api", "GET", "/rpc/orders.total"), procedureHandler("orders.total", "api", "query"));
    expect(problems.map(problem => problem.details)).toEqual([{ route: "GET /api/rpc/orders.total", handlers: ["a", "orders.total"] }]);
  });
});

describe("matchRoute", () => {
  const { table } = tableOf("/api", routeHandler("orders.get", "api", "GET", "/orders/:id"), routeHandler("orders.new", "api", "POST", "/orders/new"), procedureHandler("orders.total", "api", "query"));

  it("matches with decoded parameters and ignores a trailing slash", () => {
    expect(matchRoute(table, "GET", "/api/orders/a%2Fb/")).toMatchObject({ kind: "matched", entry: { handlerId: "orders.get" }, params: { id: "a/b" } });
    expect(matchRoute(table, "HEAD", "/api/orders/1")).toMatchObject({ kind: "matched", entry: { handlerId: "orders.get" } });
  });

  it("falls back to a parameter route when the static route lacks the method", () => {
    expect(matchRoute(table, "GET", "/api/orders/new")).toMatchObject({ kind: "matched", entry: { handlerId: "orders.get" }, params: { id: "new" } });
  });

  it("reports method mismatches with every allowed method, and the transport of unmatched paths", () => {
    expect(matchRoute(table, "DELETE", "/api/orders/new")).toEqual({ kind: "method-not-allowed", allowed: ["GET", "HEAD", "POST"], transport: "http" });
    expect(matchRoute(table, "GET", "/api/rpc/unknown")).toEqual({ kind: "not-found", transport: "rpc" });
    expect(matchRoute(table, "GET", "/elsewhere")).toEqual({ kind: "not-found", transport: "http" });
    expect(matchRoute(table, "GET", "/api/orders/%zz")).toEqual({ kind: "malformed", transport: "http" });
  });

  it("never lets a parameter named __proto__ change the prototype", () => {
    const { table: proto } = tableOf("/", routeHandler("p", "api", "GET", "/p/:__proto__"));
    const match = matchRoute(proto, "GET", "/p/polluted");
    expect(match.kind === "matched" && Object.getPrototypeOf(match.params)).toBe(Object.prototype);
    expect(match.kind === "matched" && Object.hasOwn(match.params, "__proto__")).toBe(true);
  });
});