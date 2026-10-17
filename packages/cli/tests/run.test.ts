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
 * @returns The exit code and everything written to each stream.
 */
function run(argv: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    }
  }, "1.2.3");
  return { code, stdout, stderr };
}

describe("runCli", () => {
  it("prints help when called without arguments", () => {
    const result = run([]);
    expect(result.code).toBe(exitCodes.success);
    expect(result.stdout).toContain("Usage: holqa");
    expect(result.stdout).toContain("not implemented yet");
    expect(result.stderr).toBe("");
  });

  it("prints the version", () => {
    expect(run(["--version"])).toEqual({ code: 0, stdout: "1.2.3", stderr: "" });
    expect(run(["-v", "--json"]).stdout).toBe("{\"version\":\"1.2.3\"}");
  });

  it("reports proposed commands as not implemented", () => {
    const result = run(["queue", "send", "orders"]);
    expect(result.code).toBe(exitCodes.failure);
    expect(result.stderr).toContain("HOLQA_CLI_NOT_IMPLEMENTED");
    expect(result.stderr).toContain("holqa queue send");
  });

  it("reports unknown commands as usage errors", () => {
    const result = run(["deploy"]);
    expect(result.code).toBe(exitCodes.usage);
    expect(result.stderr).toContain("HOLQA_CLI_UNKNOWN_COMMAND");
  });

  it("emits machine-readable diagnostics with --json", () => {
    const result = run(["dev", "--json"]);
    const parsed = JSON.parse(result.stderr) as { diagnostics: Array<{ code: string; severity: string }> };
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({ code: "HOLQA_CLI_NOT_IMPLEMENTED", severity: "error" });
  });
});