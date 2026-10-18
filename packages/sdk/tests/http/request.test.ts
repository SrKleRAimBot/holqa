import { isHttpRejectedError } from "@holqa/core";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  hasJsonContentType,
  readHeaders,
  readJsonBody,
  readQuery,
  readRequestPart
} from "@/http/request";

describe("request parts", () => {
  it("reads repeated query parameters as lists and keeps __proto__ an ordinary key", () => {
    const query = readQuery(new URL("http://localhost/?a=1&b=2&b=3&__proto__=x"));
    expect(query).toEqual({ a: "1", b: ["2", "3"], ["__proto__"]: "x" });
    expect(Object.getPrototypeOf(query)).toBe(Object.prototype);
    expect(Object.isFrozen(query)).toBe(true);
  });

  it("reads headers with lowercase names", () => {
    expect(readHeaders(new Headers({ "X-Tenant": "acme" }))).toEqual({ "x-tenant": "acme" });
  });

  it.each([
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["application/problem+json", true],
    ["text/plain", false],
    ["application/jsonp", false]
  ])("recognizes %p as JSON: %p", (contentType, expected) => {
    expect(hasJsonContentType(new Request("http://localhost/", { method: "POST", headers: { "content-type": contentType } }))).toBe(expected);
  });

  it("reads JSON bodies, treats an empty body as undefined and rejects other media types and malformed JSON", async () => {
    expect(await readJsonBody(new Request("http://localhost/", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"a\":1}" }), "body")).toEqual({ a: 1 });
    expect(await readJsonBody(new Request("http://localhost/", { method: "POST" }), "body")).toBeUndefined();
    await expect(readJsonBody(new Request("http://localhost/", { method: "POST", body: "a=1" }), "body")).rejects.toThrow("application/json");
    await expect(readJsonBody(new Request("http://localhost/", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), "body")).rejects.toThrow();
  });

  it("marks Holqa errors from reading as the caller's fault and leaves other errors alone", async () => {
    const unsupported = await readRequestPart(async () => readJsonBody(new Request("http://localhost/", { method: "POST", body: "a=1" }), "body")).catch((error: unknown) => error);
    expect(isHttpRejectedError(unsupported) && [unsupported.status, unsupported.code]).toEqual([415, "HOLQA_HTTP_MEDIA_TYPE_UNSUPPORTED"]);
    const plain = new TypeError("bug");
    expect(await readRequestPart(async () => {
      throw plain;
    }).catch((error: unknown) => error)).toBe(plain);
  });
});