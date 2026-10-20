import type { CliHost } from "@/analysis/host";

import { join } from "node:path";

import {
  describe,
  expect,
  it,
  setDefaultTimeout
} from "bun:test";

import { createProcessHost } from "@/analysis/process-host";
import { runCli } from "@/run";

setDefaultTimeout(60_000);

const { PATH } = process.env;
const root = join(import.meta.dir, "..", "fixtures", "apps", "bound");

/**
 * Runs the CLI against the fixture.
 *
 * @param argv - The arguments.
 * @returns The exit code and output.
 */
async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const host: CliHost = createProcessHost({ cwd: root, environment: { PATH } });
  const code = await runCli(argv, { stdout: text => stdout.push(text), stderr: text => stderr.push(text) }, "1.2.3", host);
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("holqa providers test", () => {
  it("runs the selected provider's conformance suite and reports every case", async () => {
    const { code, stdout } = await run(["providers", "test", "--only", "local queues"]);
    expect(code).toBe(0);
    expect(stdout).toContain("local queues (queue)");
    expect(stdout).toContain("✓ a sent envelope is delivered unchanged, with its message identifier and attempt 1");
    expect(stdout).toMatch(/\d+ passed, 0 failed, \d+ skipped\./);
  });

  it("fails when a provider breaks the contract, with the broken cases in the JSON report", async () => {
    const { code, stdout } = await run(["providers", "test", "--only", "lossy queues", "--timeout", "5000", "--json"]);
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as { readonly format: string; readonly summary: { readonly failed: number }; readonly suites: ReadonlyArray<{ readonly results: ReadonlyArray<{ readonly status: string }> }> };
    expect(report.format).toBe("holqa.provider-tests/1");
    expect(report.summary.failed).toBeGreaterThan(0);
  });

  it("reports unknown names, a missing module and invalid options", async () => {
    expect((await run(["providers", "test", "--only", "nope", "--json"])).stderr).toContain("No provider test is named");
    expect(JSON.parse((await run(["providers", "test", "--tests", "nope.ts", "--json"])).stderr)).toMatchObject({ diagnostics: [{ code: "HOLQA_FILE_UNREADABLE" }] });
    expect((await run(["providers", "test", "--timeout", "soon"])).code).toBe(2);
  });
});