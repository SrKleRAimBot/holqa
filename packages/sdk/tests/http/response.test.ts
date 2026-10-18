import {
  describe,
  expect,
  it
} from "bun:test";
import { z } from "zod";

import {
  encodeContractValue,
  jsonResponse,
  responseInvalid
} from "@/http/response";

describe("responses", () => {
  it("sends the validated output, as the compiler describes response roles", async () => {
    expect(await encodeContractValue(z.string().transform(text => text.length), "four", "200 response")).toBe(4);
    expect(await encodeContractValue(z.object({ a: z.number().default(1) }), {}, "200 response")).toEqual({ a: 1 });
    expect(await encodeContractValue(z.undefined(), undefined, "204 response")).toBeUndefined();
  });

  it("rejects values the schema rejects and outputs without a JSON form", async () => {
    await expect(encodeContractValue(z.number(), "x", "200 response")).rejects.toThrow();
    await expect(encodeContractValue(z.string().transform(text => new Date(text)), "2026-01-01", "200 response")).rejects.toThrow();
  });

  it("builds JSON responses and refuses bodies on statuses that forbid them", async () => {
    const response = jsonResponse(201, { a: 1 }, { location: "/a" }, "201 response");
    expect([response.status, response.headers.get("content-type"), response.headers.get("location"), await response.json()]).toEqual([201, "application/json; charset=utf-8", "/a", { a: 1 }]);
    expect(jsonResponse(204, undefined, undefined, "204 response").body).toBeNull();
    expect(() => jsonResponse(204, { a: 1 }, undefined, "204 response")).toThrow();
  });

  it("describes contract violations with the causes' codes for logs", () => {
    const error = responseInvalid("Bad.", Object.assign(new Error("x"), { diagnostics: [{ code: "HOLQA_INPUT_INVALID", severity: "error", message: "Nope." }] }), { status: 200 });
    expect(error.code).toBe("HOLQA_RESPONSE_INVALID");
    expect(error.diagnostics[0]?.details).toEqual({ status: 200, causes: [{ code: "HOLQA_INPUT_INVALID", message: "Nope." }] });
  });
});