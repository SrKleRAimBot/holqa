import { join } from "node:path";

import {
  describe,
  expect,
  it
} from "bun:test";

import { runAnalysis } from "@/analysis/run-analysis";

/** The fixture applications. */
const apps = join(import.meta.dir, "..", "fixtures", "apps");

describe("runAnalysis", () => {
  it("evaluates the application and its handler modules and compiles them", async () => {
    const report = await runAnalysis({ root: join(apps, "basic"), appModule: "infra.ts" });
    expect(report.ok).toBe(true);
    expect(report.manifest).toMatchObject({ application: { name: "basic" }, handlers: [{ id: "orders.process" }] });
    expect(report.entrypoints).toMatchObject({ application: { module: "infra.ts" }, handlers: [{ id: "orders.process", module: "src/orders.handler.ts", export: "default" }] });
    expect(report.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.location])).toEqual([
      ["HOLQA_SCHEMA_FIDELITY_UNVERIFIED", { file: "infra.ts", line: 16, column: 44 }]
    ]);
  });

  it("reports every evaluation and graph problem with locations and no manifest", async () => {
    const report = await runAnalysis({ root: join(apps, "broken"), appModule: "infra.ts" });
    expect(report.ok).toBe(false);
    expect(report.manifest).toBeUndefined();
    expect(report.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.location])).toEqual([
      ["HOLQA_SCHEMA_FIDELITY_UNVERIFIED", { file: "infra.ts", line: 7, column: 45 }],
      ["HOLQA_RESOURCE_NOT_FOUND", { file: "src/refunds.handler.ts", line: 5, column: 3 }],
      ["HOLQA_MODULE_EVALUATION_FAILED", { file: "src/throws.handler.ts" }]
    ]);
  });

  it("reports a missing application module", async () => {
    const report = await runAnalysis({ root: join(apps, "basic"), appModule: "missing.ts" });
    expect(report.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_APP_NOT_FOUND"]);
  });
});