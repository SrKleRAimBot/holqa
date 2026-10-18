import {
  describe,
  expect,
  it
} from "bun:test";

import {
  isHttpInvocationInput,
  isResponseLike
} from "@/http/http-invocation";

describe("isHttpInvocationInput", () => {
  it("accepts a request with string path parameters", () => {
    expect(isHttpInvocationInput({ request: new Request("http://localhost/orders/1"), params: { orderId: "1" } })).toBe(true);
    expect(isHttpInvocationInput({ request: new Request("http://localhost/"), params: {} })).toBe(true);
  });

  it("accepts request-like objects from another realm", () => {
    const foreign = { method: "GET", url: "http://localhost/", headers: {} };
    expect(isHttpInvocationInput({ request: foreign, params: {} })).toBe(true);
  });

  it.each([
    ["no object", "GET /"],
    ["null", null],
    ["a missing request", { params: {} }],
    ["a request without a method", { request: { url: "http://localhost/", headers: {} }, params: {} }],
    ["missing parameters", { request: new Request("http://localhost/") }],
    ["non-string parameters", { request: new Request("http://localhost/"), params: { id: 1 } }],
    ["a parameter list", { request: new Request("http://localhost/"), params: ["1"] }]
  ])("rejects %s", (_label, value) => {
    expect(isHttpInvocationInput(value)).toBe(false);
  });
});

describe("isResponseLike", () => {
  it("recognizes responses, also structurally", () => {
    expect(isResponseLike(new Response("ok"))).toBe(true);
    expect(isResponseLike({ status: 200, headers: new Headers(), body: null, arrayBuffer: async () => new ArrayBuffer(0) })).toBe(true);
  });

  it("rejects values that are not responses", () => {
    expect(isResponseLike({ status: 200, body: "ok" })).toBe(false);
    expect(isResponseLike({ status: 200, headers: { location: "/" }, body: {} })).toBe(false);
    expect(isResponseLike({ status: "200", headers: {}, body: null })).toBe(false);
    expect(isResponseLike(undefined)).toBe(false);
  });
});