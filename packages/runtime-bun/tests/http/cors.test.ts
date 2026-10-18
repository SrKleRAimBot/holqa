import {
  describe,
  expect,
  it
} from "bun:test";

import {
  CorsPolicy,
  isPreflight
} from "@/http/cors";

describe("CorsPolicy", () => {
  it("allows exact origins, every origin, or a predicate", () => {
    expect(new CorsPolicy({ origins: ["https://a.example"] }).allows("https://a.example")).toBe(true);
    expect(new CorsPolicy({ origins: ["https://a.example"] }).allows("https://b.example")).toBe(false);
    expect(new CorsPolicy({ origins: "*" }).allows("https://any.example")).toBe(true);
    expect(new CorsPolicy({ origins: origin => origin.endsWith(".example") }).allows("https://c.example")).toBe(true);
  });

  it("varies on origin for listed origins, also when it sends no CORS headers", () => {
    const policy = new CorsPolicy({ origins: ["https://a.example"] });
    expect(policy.responseHeaders(null)).toEqual({ vary: "origin" });
    expect(policy.responseHeaders("https://b.example")).toEqual({ vary: "origin" });
    expect(policy.responseHeaders("https://a.example")).toEqual({ "access-control-allow-origin": "https://a.example", "access-control-expose-headers": "x-correlation-id", "vary": "origin" });
    expect(new CorsPolicy({ origins: "*" }).responseHeaders(null)).toEqual({});
  });

  it("answers preflights with the path's methods and the requested or configured headers", () => {
    const request = new Request("http://localhost/", { method: "OPTIONS", headers: { "origin": "https://a.example", "access-control-request-method": "POST", "access-control-request-headers": "x-a" } });
    expect(isPreflight(request)).toBe(true);
    expect(new CorsPolicy({ origins: "*" }).preflightHeaders(request, ["GET", "POST"])).toMatchObject({ "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "x-a" });
    expect(new CorsPolicy({ origins: "*", allowHeaders: ["content-type"] }).preflightHeaders(request, ["POST"])).toMatchObject({ "access-control-allow-headers": "content-type" });
    expect(new CorsPolicy({ origins: ["https://b.example"] }).preflightHeaders(request, ["POST"])).toEqual({ vary: "origin" });
    expect(isPreflight(new Request("http://localhost/", { method: "OPTIONS" }))).toBe(false);
  });

  it.each([
    ["credentials with every origin", { origins: "*" as const, credentials: true }],
    ["a wildcard inside a list", { origins: ["*"] }],
    ["a negative max age", { origins: "*" as const, maxAgeSeconds: -1 }]
  ])("rejects %s", (_label, options) => {
    expect(() => new CorsPolicy(options)).toThrow();
  });
});