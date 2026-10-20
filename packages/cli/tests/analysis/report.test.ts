import { compiledOutcome } from "@test/support/fake-host";

import {
  describe,
  expect,
  it
} from "bun:test";
import {
  analysisReportFormat,
  readAnalysisReport
} from "@/analysis/report";

/**
 * Builds a report text from a valid outcome with overrides.
 *
 * @param overrides - Fields to replace in the report.
 * @returns The JSON text an analysis process would send.
 */
async function reportText(overrides: Record<string, unknown> = {}): Promise<string> {
  const outcome = await compiledOutcome();
  if (!outcome.ok)
    throw new Error("Expected the fixture to compile.");
  return JSON.stringify({ format: analysisReportFormat, ok: true, manifest: outcome.manifest, entrypoints: outcome.entrypoints, events: outcome.events, diagnostics: outcome.diagnostics, ...overrides });
}

describe("readAnalysisReport", () => {
  it("accepts a valid report and keeps the process output", async () => {
    const outcome = await readAnalysisReport(await reportText(), "printed");
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toBe("printed");
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_SCHEMA_FIDELITY_UNVERIFIED"]);
  });

  it.each([
    ["not JSON", "{"],
    ["another format", JSON.stringify({ format: "other", ok: true, diagnostics: [] })],
    ["an unregistered diagnostic code", JSON.stringify({ format: analysisReportFormat, ok: false, diagnostics: [{ code: "HOLQA_MADE_UP", severity: "error", message: "x" }] })],
    ["a malformed location", JSON.stringify({ format: analysisReportFormat, ok: false, diagnostics: [{ code: "HOLQA_APP_INVALID", severity: "error", message: "x", location: { file: "a.ts", line: 0 } }] })],
    ["failure without an error", JSON.stringify({ format: analysisReportFormat, ok: false, diagnostics: [] })]
  ])("rejects a report with %s", async (_name, text) => {
    const outcome = await readAnalysisReport(text, "");
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toContain("HOLQA_ANALYSIS_FAILED");
  });

  it("validates the manifest and entry points it receives", async () => {
    const tampered = JSON.parse(await reportText()) as { manifest: { manifestVersion: number }; entrypoints: { manifest: string } };
    const wrongVersion = await readAnalysisReport(JSON.stringify({ ...tampered, manifest: { ...tampered.manifest, manifestVersion: 9 } }), "");
    expect(wrongVersion.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_MANIFEST_VERSION_UNSUPPORTED"]);
    const otherManifest = await readAnalysisReport(JSON.stringify({ ...tampered, entrypoints: { ...tampered.entrypoints, manifest: `sha256:${"f".repeat(64)}` } }), "");
    expect(otherManifest.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_MANIFEST_INVALID"]);
  });

  it("rejects a report whose event analysis is malformed, and accepts one without it", async () => {
    const outcome = await readAnalysisReport(await reportText({ events: { graph: { nodes: "x", edges: [], unresolved: [] }, cycles: [] } }), "");
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_ANALYSIS_FAILED"]);
    const without = await readAnalysisReport(await reportText({ events: undefined }), "");
    expect(without.ok).toBe(true);
    expect(without.ok && without.events).toBeUndefined();
  });

  it("accepts a well-formed binding report and rejects one that cannot be trusted, including malformed entries the output would read", async () => {
    const provider = { name: "local", provider: "holqa.local", role: "platform", contracts: { queue: 1 }, capabilities: {}, limits: {}, services: ["config"], emulations: [], topology: { delivery: "pull", state: "host" }, settings: {}, credentials: [] };
    const bindings = { format: "holqa.bindings/1", name: "local", application: "basic", resources: [{ id: "orders", kind: "queue", provider: "local", selection: "default", requirements: [{ capability: "queue", support: "native" }] }], services: [{ service: "config", providers: ["local"], selection: "default" }], providers: [provider], diagnostics: [] };
    const outcome = await readAnalysisReport(await reportText({ bindings }), "");
    expect(outcome.ok ? outcome.bindings as unknown : undefined).toEqual(bindings);
    for (const tampered of [{ ...bindings, format: "other" }, { ...bindings, resources: "x" }, { ...bindings, diagnostics: [{ code: "HOLQA_MADE_UP", severity: "error", message: "x" }] }, { ...bindings, resources: [{ id: 1 }] }, { ...bindings, providers: [{}] }, { ...bindings, providers: [{ ...provider, contracts: undefined }] }, { ...bindings, providers: [{ ...provider, emulations: [{ capability: "queue.delay" }] }] }, { ...bindings, services: [{ service: "config" }] }, { ...bindings, resources: [{ ...bindings.resources[0], requirements: [{ capability: "queue" }] }] }]) {
      const rejected = await readAnalysisReport(await reportText({ bindings: tampered }), "");
      expect(rejected.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_ANALYSIS_FAILED"]);
    }
  });
});