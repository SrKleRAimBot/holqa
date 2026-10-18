import type { CliHost } from "@/analysis/host";

import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";
import {
  compiledOutcome,
  fakeHost
} from "@test/support/fake-host";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  exitCodes,
  runCli
} from "@/run";

/**
 * Runs the CLI with in-memory output streams.
 *
 * @param argv - The CLI arguments.
 * @param host - The host for commands that analyze applications.
 * @returns The exit code and everything written to each stream.
 */
async function run(argv: string[], host?: CliHost): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    }
  }, "1.2.3", host);
  return { code, stdout, stderr };
}

describe("runCli", () => {
  it("prints help when called without arguments", async () => {
    const result = await run([]);
    expect(result.code).toBe(exitCodes.success);
    expect(result.stdout).toContain("Usage: holqa");
    expect(result.stdout).toContain("holqa inspect [--app <path>]");
    expect(result.stdout).toContain("not implemented yet");
    expect(result.stdout).toContain("runs their code");
    expect(result.stderr).toBe("");
  });

  it("prints the version", async () => {
    expect(await run(["--version"])).toEqual({ code: 0, stdout: "1.2.3", stderr: "" });
    expect((await run(["-v", "--json"])).stdout).toBe("{\"version\":\"1.2.3\"}");
  });

  it("reports proposed commands as not implemented", async () => {
    const result = await run(["openapi", "generate"]);
    expect(result.code).toBe(exitCodes.failure);
    expect(result.stderr).toContain("HOLQA_CLI_NOT_IMPLEMENTED");
    expect(result.stderr).toContain("holqa openapi generate");
  });

  it("reports unknown commands as usage errors", async () => {
    const result = await run(["deploy"]);
    expect(result.code).toBe(exitCodes.usage);
    expect(result.stderr).toContain("HOLQA_CLI_UNKNOWN_COMMAND");
  });

  it("emits machine-readable diagnostics with --json", async () => {
    const result = await run(["openapi", "generate", "--json"]);
    const parsed = JSON.parse(result.stderr) as { diagnostics: Array<{ code: string; severity: string }> };
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({ code: "HOLQA_CLI_NOT_IMPLEMENTED", severity: "error" });
  });
});

describe("holqa inspect", () => {
  it("analyzes infra.ts in the working directory and prints a summary", async () => {
    const host = fakeHost(await compiledOutcome());
    const result = await run(["inspect"], host);
    expect(result.code).toBe(exitCodes.success);
    expect(host.analyzed).toEqual(["/work/shop/infra.ts"]);
    expect(result.stdout).toContain("Application \"basic\"");
    expect(result.stdout).toContain("orders.process  queue.message <- queue \"orders\"");
    expect(result.stdout).toContain("src/orders.handler.ts#default");
    expect(result.stderr).toContain("evaluating");
    expect(result.stderr).toContain("HOLQA_SCHEMA_FIDELITY_UNVERIFIED");
  });

  it("prints one canonical JSON document with --json", async () => {
    const host = fakeHost(await compiledOutcome());
    const result = await run(["inspect", "--app", "apps/infra.ts", "--json"], host);
    expect(result.code).toBe(exitCodes.success);
    expect(host.analyzed).toEqual(["/work/shop/apps/infra.ts"]);
    expect(result.stderr).toBe("");
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual(["diagnostics", "entrypoints", "graph", "manifest"]);
    expect(document).toMatchObject({ manifest: { manifestVersion: 1, application: { name: "basic" } }, graph: { edges: expect.any(Array) } });
  });

  it("reports analysis failures as diagnostics with exit code 1", async () => {
    const failure = createDiagnostic({ code: diagnosticCodes.resourceNotFound, severity: "error", message: "missing", location: { file: "src/a.handler.ts", line: 3, column: 7 } });
    const host = fakeHost({ ok: false, diagnostics: [failure], output: "" });
    const text = await run(["inspect"], host);
    expect(text).toEqual({ code: 1, stdout: "", stderr: "src/a.handler.ts:3:7 error HOLQA_RESOURCE_NOT_FOUND: missing" });
    const json = await run(["inspect", "--json"], host);
    expect(JSON.parse(json.stderr)).toEqual({ diagnostics: [failure] });
  });

  it("rejects unknown options with exit code 2 without analyzing", async () => {
    const host = fakeHost(await compiledOutcome());
    const result = await run(["inspect", "--watch", "--json"], host);
    expect(result.code).toBe(exitCodes.usage);
    expect(JSON.parse(result.stderr)).toMatchObject({ diagnostics: [{ code: "HOLQA_CLI_ARGUMENT_INVALID" }] });
    expect(host.analyzed).toEqual([]);
  });
});

describe("holqa build", () => {
  it("writes the manifest and entry points next to the application by default", async () => {
    const outcome = await compiledOutcome();
    const host = fakeHost(outcome);
    const result = await run(["build", "--manifest"], host);
    expect(result.code).toBe(exitCodes.success);
    expect([...host.written.keys()]).toEqual(["/work/shop/.holqa/build/manifest.json", "/work/shop/.holqa/build/entrypoints.json"]);
    const manifest = host.written.get("/work/shop/.holqa/build/manifest.json")!;
    expect(manifest.endsWith("}\n")).toBe(true);
    expect(JSON.parse(manifest)).toEqual(JSON.parse(JSON.stringify(outcome.ok && outcome.manifest)));
    expect(result.stdout).toContain("Wrote .holqa/build/manifest.json (sha256:");
  });

  it("reports the written paths and manifest fingerprint with --json", async () => {
    const outcome = await compiledOutcome();
    const host = fakeHost(outcome);
    const result = await run(["build", "--manifest", "--out-dir", "dist/holqa", "--json"], host);
    expect(JSON.parse(result.stdout)).toEqual({
      diagnostics: expect.any(Array),
      manifest: { path: "dist/holqa/manifest.json", fingerprint: outcome.ok ? outcome.entrypoints.manifest : "" },
      entrypoints: { path: "dist/holqa/entrypoints.json" }
    });
  });

  it("reports write failures", async () => {
    const result = await run(["build", "--manifest", "--json"], fakeHost(await compiledOutcome(), { failWrites: true }));
    expect(result.code).toBe(exitCodes.failure);
    expect(JSON.parse(result.stderr)).toMatchObject({ diagnostics: [{ code: "HOLQA_BUILD_OUTPUT_FAILED" }] });
  });

  it("does not bundle: without --manifest it reports a planned feature", async () => {
    const host = fakeHost(await compiledOutcome());
    const result = await run(["build"], host);
    expect(result.code).toBe(exitCodes.failure);
    expect(result.stderr).toContain("HOLQA_CLI_NOT_IMPLEMENTED");
    expect(host.analyzed).toEqual([]);
  });
});
describe("CLI paths", () => {
  it("shows diagnostic locations relative to the working directory", async () => {
    const failure = createDiagnostic({ code: diagnosticCodes.resourceNotFound, severity: "error", message: "missing", location: { file: "src/a.handler.ts", line: 3 } });
    const result = await run(["inspect", "--app", "apps/shop/infra.ts"], fakeHost({ ok: false, diagnostics: [failure], output: "" }));
    expect(result.stderr).toBe("apps/shop/src/a.handler.ts:3 error HOLQA_RESOURCE_NOT_FOUND: missing");
  });

  it("shows paths outside the working directory as absolute paths", async () => {
    const result = await run(["build", "--manifest", "--out-dir", "/srv/out", "--json"], fakeHost(await compiledOutcome()));
    expect(JSON.parse(result.stdout)).toMatchObject({ manifest: { path: "/srv/out/manifest.json" } });
  });
});