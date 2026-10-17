import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";
import {
  experimentCodes,
  experimentDiagnostic,
  HolqaError
} from "@holqa/experiment-model";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  moduleEvaluationFailure,
  sortDiagnostics
} from "@/diagnostics";

describe("moduleEvaluationFailure", () => {
  it("names the cause code and suggests moving runtime access out of module top level", () => {
    const cause = new HolqaError(experimentDiagnostic({ code: experimentCodes.runtimeNotBound, severity: "error", message: "env.DATABASE_URL was used while unbound." }));
    const diagnostic = moduleEvaluationFailure("src/db.ts", cause);
    expect(diagnostic.code).toBe(experimentCodes.moduleEvaluationFailed);
    expect(diagnostic.location).toEqual({ file: "src/db.ts" });
    expect(diagnostic.message).toContain(experimentCodes.runtimeNotBound);
    expect(diagnostic.hint).toContain("module top level");
  });

  it("accepts thrown non-errors", () => {
    expect(moduleEvaluationFailure("src/a.ts", "boom").message).toContain("boom");
  });
});

describe("sortDiagnostics", () => {
  it("orders by file, then code, then message", () => {
    const sorted = sortDiagnostics([
      experimentDiagnostic({ code: experimentCodes.routeAmbiguous, severity: "error", message: "b", location: { file: "infra.ts" } }),
      createDiagnostic({ code: diagnosticCodes.resourceIdInvalid, severity: "error", message: "a", location: { file: "infra.ts" } }),
      experimentDiagnostic({ code: experimentCodes.routeAmbiguous, severity: "error", message: "a", location: { file: "a.ts" } })
    ]);
    expect(sorted.map(diagnostic => `${diagnostic.location?.file} ${diagnostic.code} ${diagnostic.message}`)).toEqual([
      "a.ts HOLQA_ROUTE_AMBIGUOUS a",
      "infra.ts HOLQA_RESOURCE_ID_INVALID a",
      "infra.ts HOLQA_ROUTE_AMBIGUOUS b"
    ]);
  });
});