import {
  describe,
  expect,
  it
} from "bun:test";

import { runtimeFailure } from "@/dispatch/failure";
import {
  errorDetail,
  errorResponse
} from "@/http/error-response";

describe("error responses", () => {
  const failure = runtimeFailure("HOLQA_HTTP_METHOD_NOT_ALLOWED", "PUT is not allowed.", { allow: "GET" });

  it("builds the detail without absent fields", () => {
    expect(errorDetail(failure, undefined)).toEqual({ code: "HOLQA_HTTP_METHOD_NOT_ALLOWED", message: "PUT is not allowed." });
    expect(errorDetail(failure, "inv-1")).toEqual({ code: "HOLQA_HTTP_METHOD_NOT_ALLOWED", message: "PUT is not allowed.", invocationId: "inv-1" });
  });

  it("encodes route errors and RPC failure envelopes with the failure's status and headers", async () => {
    const route = errorResponse(failure, "http", "inv-1");
    expect([route.status, route.headers.get("allow"), route.headers.get("content-type")]).toEqual([405, "GET", "application/json; charset=utf-8"]);
    expect(await route.json()).toEqual({ error: { code: "HOLQA_HTTP_METHOD_NOT_ALLOWED", message: "PUT is not allowed.", invocationId: "inv-1" } });
    expect(await errorResponse(failure, "rpc", undefined).json()).toEqual({ format: "holqa.rpc/1", ok: false, error: { code: "HOLQA_HTTP_METHOD_NOT_ALLOWED", message: "PUT is not allowed." } });
  });
});