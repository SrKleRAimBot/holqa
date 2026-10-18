import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describe,
  expect,
  it,
  setDefaultTimeout
} from "bun:test";

import {
  createProcessHost,
  forwardedEnvironment
} from "@/analysis/process-host";

// Every test here spawns Bun processes; allow for slow machines.
setDefaultTimeout(20_000);

/** The fixture applications. */
const apps = join(import.meta.dir, "..", "fixtures", "apps");

describe("createProcessHost", () => {
  it("analyzes in a separate process and withholds the CLI's environment", async () => {
    const host = createProcessHost({ cwd: apps, environment: { ...process.env, HOLQA_FIXTURE_SECRET: "s3cr3t" } });
    const outcome = await host.analyze(join(apps, "basic", "infra.ts"));
    if (!outcome.ok)
      throw new Error(JSON.stringify(outcome.diagnostics));
    expect(outcome.manifest.application.name as string).toBe("basic");
    expect(outcome.output).toContain("evaluating the basic fixture");
    expect(JSON.stringify(outcome)).not.toContain("s3cr3t");
  });

  it("does not load .env files next to the application", async () => {
    const envFile = join(apps, "basic", ".env");
    writeFileSync(envFile, "HOLQA_FIXTURE_SECRET=from-dotenv\n");
    try {
      const outcome = await createProcessHost({ cwd: apps }).analyze(join(apps, "basic", "infra.ts"));
      expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).not.toContain("HOLQA_MODULE_EVALUATION_FAILED");
      expect(outcome.ok).toBe(true);
    } finally {
      rmSync(envFile, { force: true });
    }
  });

  it("returns after a timeout even when a grandchild process keeps the output pipes open", async () => {
    const outcome = await createProcessHost({ cwd: apps, timeoutMs: 1000 }).analyze(join(apps, "orphan", "infra.ts"));
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_ANALYSIS_FAILED"]);
  });

  it("rejects a report that is not text", async () => {
    const workerPath = join(import.meta.dir, "..", "fixtures", "workers", "sends-object.ts");
    const outcome = await createProcessHost({ cwd: apps, workerPath }).analyze(join(apps, "basic", "infra.ts"));
    expect(outcome.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.message])).toEqual([["HOLQA_ANALYSIS_FAILED", "The analysis process sent a report that is too large or not text."]]);
  });

  it("forwards only an allowlist of variables", () => {
    expect([...forwardedEnvironment]).toEqual(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"]);
  });

  it("reports a missing application without spawning", async () => {
    const outcome = await createProcessHost({ cwd: apps }).analyze(join(apps, "nowhere", "infra.ts"));
    expect(outcome.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.message])).toEqual([["HOLQA_APP_NOT_FOUND", "The application module \"nowhere/infra.ts\" does not exist."]]);
  });

  it("kills analysis that exceeds the timeout", async () => {
    const outcome = await createProcessHost({ cwd: apps, timeoutMs: 1000 }).analyze(join(apps, "hangs", "infra.ts"));
    expect(outcome.diagnostics.map(({ code, details }) => [code, details === undefined ? undefined : Object.entries(details).find(([key]) => key === "timeoutMs")?.[1]])).toEqual([["HOLQA_ANALYSIS_FAILED", 1000]]);
  });

  it("reports a process that exits during evaluation", async () => {
    const outcome = await createProcessHost({ cwd: apps }).analyze(join(apps, "exits", "infra.ts"));
    expect(outcome.diagnostics.map(({ code, details }) => [code, details === undefined ? undefined : Object.entries(details).find(([key]) => key === "exitCode")?.[1]])).toEqual([["HOLQA_ANALYSIS_FAILED", 3]]);
  });

  it("writes files and creates missing directories", async () => {
    const directory = mkdtempSync(join(tmpdir(), "holqa-cli-"));
    try {
      const path = join(directory, "nested", "file.json");
      await createProcessHost().writeFile(path, "{}\n");
      expect(await Bun.file(path).text()).toBe("{}\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});