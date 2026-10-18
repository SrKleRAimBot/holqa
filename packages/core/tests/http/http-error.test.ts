import {
  describe,
  expect,
  it
} from "bun:test";

import { isHolqaError } from "@/errors/holqa-error";
import {
  HttpRejectedError,
  isHttpRejectedError
} from "@/http/http-error";
import { InputValidationError } from "@/schema/validate-input";

describe("HttpRejectedError", () => {
  it("is a Holqa error with the HOLQA_HTTP_REJECTED code, its status and response headers", () => {
    const error = new HttpRejectedError(401, "Sign in to continue.", { headers: { "www-authenticate": "Bearer" } });
    expect(isHolqaError(error)).toBe(true);
    expect(error.code).toBe("HOLQA_HTTP_REJECTED");
    expect(error.status).toBe(401);
    expect(error.headers).toEqual({ "www-authenticate": "Bearer" });
    expect(Object.isFrozen(error.headers)).toBe(true);
    expect(error.issues).toEqual([]);
    expect(error.diagnostics[0]?.details).toEqual({ status: 401 });
  });

  it("copies headers, so later changes to the caller's object do not leak into the response", () => {
    const headers: Record<string, string> = { "retry-after": "5" };
    const error = new HttpRejectedError(503, "Try again later.", { headers });
    headers["retry-after"] = "60";
    expect(error.headers).toEqual({ "retry-after": "5" });
    expect(new HttpRejectedError(403, "Forbidden.").headers).toEqual({});
  });

  it("keeps the diagnostics and issues of a Holqa error cause", () => {
    const cause = new InputValidationError("body of POST /orders", [{ message: "Expected a number.", path: "total" }]);
    const error = new HttpRejectedError(400, "ignored", { cause });
    expect(error.code).toBe("HOLQA_INPUT_INVALID");
    expect(error.issues.map(issue => issue.path)).toEqual(["total"]);
    expect(error.cause).toBe(cause);
    expect(new HttpRejectedError(500, "Failed.", { cause: new Error("plain") }).code).toBe("HOLQA_HTTP_REJECTED");
  });

  it("rejects invalid header names and values, which would make the error response fail", () => {
    expect(() => new HttpRejectedError(401, "No.", { headers: { "bad name": "v" } })).toThrow(RangeError);
    expect(() => new HttpRejectedError(401, "No.", { headers: { "x-ok": "a\r\nset-cookie: b" } })).toThrow(RangeError);
  });

  it.each([200, 302, 399, 600, 404.5, Number.NaN])("rejects the non-error status %p", (status) => {
    expect(() => new HttpRejectedError(status, "No.")).toThrow(RangeError);
  });

  it("is recognized by shape across copies of the package", () => {
    expect(isHttpRejectedError(new HttpRejectedError(404, "Missing."))).toBe(true);
    const diagnostics = [{ code: "HOLQA_HTTP_REJECTED", severity: "error", message: "x" }];
    const foreign = Object.assign(new Error("x"), { name: "HttpRejectedError", status: 409, headers: {}, issues: [], diagnostics });
    expect(isHttpRejectedError(foreign)).toBe(true);
    expect(isHttpRejectedError({ ...foreign, status: 200 })).toBe(false);
    expect(isHttpRejectedError(Object.assign(new Error("x"), { name: "HttpRejectedError", status: 9999, headers: {}, issues: [], diagnostics }))).toBe(false);
    expect(isHttpRejectedError(Object.assign(new Error("x"), { name: "HttpRejectedError", status: 409, headers: { "bad name": "v" }, issues: [], diagnostics }))).toBe(false);
    expect(isHttpRejectedError(Object.assign(new Error("x"), { name: "HttpRejectedError", status: 409, headers: {}, diagnostics }))).toBe(false);
    expect(isHttpRejectedError(Object.assign(new Error("x"), { status: 409 }))).toBe(false);
    expect(isHttpRejectedError("HttpRejectedError")).toBe(false);
  });
});