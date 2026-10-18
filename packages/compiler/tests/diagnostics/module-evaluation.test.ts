import { HolqaError } from "@holqa/core";
import {
  describe,
  expect,
  it
} from "bun:test";

import { moduleEvaluationFailure } from "@/diagnostics/module-evaluation";

describe("moduleEvaluationFailure", () => {
  it("names the Holqa code of the cause and suggests lazy access for unbound runtimes", () => {
    const cause = new HolqaError([{ code: "HOLQA_RUNTIME_NOT_BOUND", severity: "error", message: "No runtime binding is installed." }]);
    const diagnostic = moduleEvaluationFailure("src/db.ts", cause);
    expect(diagnostic).toEqual(expect.objectContaining({
      code: "HOLQA_MODULE_EVALUATION_FAILED",
      location: { file: "src/db.ts" },
      details: { module: "src/db.ts", cause: "HOLQA_RUNTIME_NOT_BOUND" }
    }));
    expect(diagnostic.message).toBe("Evaluating \"src/db.ts\" threw HOLQA_RUNTIME_NOT_BOUND: No runtime binding is installed.");
    expect(diagnostic.hint).toContain("module top level");
  });

  it("reports other thrown values without a stack trace", () => {
    const diagnostic = moduleEvaluationFailure("infra.ts", "boom");
    expect(diagnostic.message).toBe("Evaluating \"infra.ts\" threw: boom");
    expect(diagnostic.details).toEqual({ module: "infra.ts" });
  });
});