import {
  HolqaError,
  HttpRejectedError,
  InputValidationError
} from "@holqa/core";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  abortFailure,
  failureFromError,
  InvocationAbort,
  runtimeFailure
} from "@/dispatch/failure";

describe("failureFromError", () => {
  it("keeps the status, code, message, headers and issues of a rejection", () => {
    const cause = new InputValidationError("body", [{ message: "Required.", path: "total" }]);
    const failure = failureFromError(new HttpRejectedError(400, "ignored", { cause, headers: { "x-reason": "validation" } }));
    expect(failure).toMatchObject({ code: "HOLQA_INPUT_INVALID", status: 400, headers: { "x-reason": "validation" } });
    expect(failure.issues.map(issue => issue.path)).toEqual(["total"]);
  });

  it("classifies the runtime's own aborts", () => {
    expect(failureFromError(new InvocationAbort("timeout"))).toMatchObject({ code: "HOLQA_INVOCATION_TIMEOUT", status: 504 });
    expect(failureFromError(new InvocationAbort("cancelled"))).toMatchObject({ code: "HOLQA_INVOCATION_CANCELLED", status: 503 });
    expect(abortFailure("shutdown").message).toContain("stopping");
  });

  it("keeps response contract violations as server errors with a generic message", () => {
    const error = new HolqaError({ code: "HOLQA_RESPONSE_INVALID", severity: "error", message: "The 200 response of GET /x has total -1." });
    const failure = failureFromError(error);
    expect(failure).toMatchObject({ code: "HOLQA_RESPONSE_INVALID", status: 500, message: "The handler produced a response that does not match its contract." });
    expect(failure.error).toBe(error);
  });

  it("turns every other error, including other Holqa errors, into HOLQA_HANDLER_FAILED", () => {
    for (const error of [new Error("boom"), "a string", new InputValidationError("queue message", [{ message: "Bad.", path: "" }])]) {
      const failure = failureFromError(error);
      expect(failure).toMatchObject({ code: "HOLQA_HANDLER_FAILED", status: 500 });
      expect(failure.message).not.toContain("boom");
      expect(failure.error).toBe(error);
    }
  });
});

describe("runtimeFailure", () => {
  it("uses the status registered for the code, or an explicit one", () => {
    expect(runtimeFailure("HOLQA_HTTP_ROUTE_NOT_FOUND", "Missing.").status).toBe(404);
    expect(runtimeFailure("HOLQA_RUNTIME_OVERLOADED", "Busy.").status).toBe(503);
    expect(runtimeFailure("HOLQA_INPUT_INVALID", "Bad path.", {}, 400).status).toBe(400);
    expect(runtimeFailure("HOLQA_CONFIG_INVALID", "Other.").status).toBe(500);
  });
});