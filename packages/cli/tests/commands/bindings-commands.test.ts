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

// Every test here spawns a Bun analysis process.
setDefaultTimeout(20_000);

/** The executable search path, passed on so the analysis process can start. */
const { PATH } = process.env;

/** The fixture application bound by `bindings.ts`. */
const root = join(import.meta.dir, "..", "fixtures", "apps", "bound");

/**
 * Runs the CLI against the fixture with a process host.
 *
 * @param argv - The arguments.
 * @param environment - The environment the host reports for credential checks.
 * @returns The exit code and output.
 */
async function run(argv: readonly string[], environment: Readonly<Record<string, string | undefined>> = { PATH }): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const host: CliHost = createProcessHost({ cwd: root, environment });
  const code = await runCli(argv, { stdout: text => stdout.push(text), stderr: text => stderr.push(text) }, "1.2.3", host);
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("holqa bindings inspect", () => {
  it("shows which provider binds each resource and why, without opening providers", async () => {
    const { code, stdout } = await run(["bindings", "inspect"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Bindings \"staging\" for application \"bound\"");
    expect(stdout).toContain("orders  queue  broker  kind default");
    expect(stdout).toContain("config  environment  built-in");
    expect(stdout).toContain("credentials: QUEUE_URL");
    expect(stdout).toContain("broker emulates queue.backoff.exponential: delay queues with message expiry (needs one delay queue per delay step)");
  });

  it("prints the report as canonical JSON", async () => {
    const { code, stdout } = await run(["bindings", "inspect", "--json"]);
    expect(code).toBe(0);
    const { bindings } = JSON.parse(stdout) as { readonly bindings: { readonly format: string; readonly resources: ReadonlyArray<{ readonly id: string; readonly selection: string; readonly requirements: ReadonlyArray<{ readonly capability: string; readonly support: string }> }> } };
    expect(bindings.format).toBe("holqa.bindings/1");
    expect(bindings.resources.map(resource => [resource.id, resource.selection])).toEqual([["audit", "kind"], ["orders", "kind"]]);
    expect(bindings.resources[0]!.requirements).toEqual([
      { capability: "queue", support: "native" },
      { capability: "queue.delivery.at-least-once", support: "native" },
      { capability: "trigger.queue.message", support: "native" }
    ]);
  });

  it("reports a missing bindings module and one that binds another application", async () => {
    const missing = await run(["bindings", "inspect", "--bindings", "nope.ts", "--json"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({ diagnostics: [{ code: "HOLQA_FILE_UNREADABLE" }] });
    const other = await run(["bindings", "inspect", "--bindings", "bindings-other-app.ts", "--json"]);
    expect(other.code).toBe(1);
    expect((JSON.parse(other.stderr) as { readonly diagnostics: ReadonlyArray<{ readonly code: string }> }).diagnostics.map(diagnostic => diagnostic.code)).toContain("HOLQA_BINDING_CONFIG_INVALID");
  });
});

describe("holqa bindings validate", () => {
  it("accepts a valid configuration and checks credentials when configuration comes from the environment", async () => {
    const missing = await run(["bindings", "validate", "--json"]);
    expect(missing.code).toBe(1);
    const report = JSON.parse(missing.stdout) as { readonly valid: boolean; readonly credentialsChecked: boolean; readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly severity: string; readonly details?: Record<string, unknown> }> };
    expect(report.valid).toBe(false);
    expect(report.credentialsChecked).toBe(true);
    expect(report.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity])).toEqual([
      ["HOLQA_BINDING_CREDENTIALS_MISSING", "error"],
      ["HOLQA_CONFIG_INVALID", "warning"]
    ]);
    const set = await run(["bindings", "validate"], { PATH, QUEUE_URL: "amqp://user:secret-password@broker", API_TOKEN: "token" });
    expect(set.code).toBe(0);
    expect(set.stdout).toBe("The binding configuration \"staging\" is valid: 2 resources, 2 providers.");
    expect(`${set.stdout}${set.stderr}`).not.toContain("secret-password");
  });

  it("fails with the problems of an invalid configuration", async () => {
    const { code, stdout, stderr } = await run(["bindings", "validate", "--bindings", "bindings-invalid.ts"], { PATH, QUEUE_URL: "amqp://broker", API_TOKEN: "t" });
    expect(code).toBe(1);
    expect(stderr).toContain("HOLQA_BINDING_TOPOLOGY_UNSUPPORTED: The handler \"audit.record\" is triggered by \"audit\", but its provider \"send-only\" delivers no events.");
    expect(stdout).toContain("is invalid: 1 error(s)");
  });

  it("rejects unknown options", async () => {
    expect((await run(["bindings", "validate", "--nope"])).code).toBe(2);
  });
});

describe("holqa inspect --capabilities", () => {
  it("lists required capabilities, and with --bindings how providers meet them", async () => {
    const required = await run(["inspect", "--capabilities"]);
    expect(required.code).toBe(0);
    expect(required.stdout).toContain("orders  queue  queue, queue.delivery.at-least-once, trigger.queue.message");
    const compared = await run(["inspect", "--capabilities", "--bindings", "bindings-invalid.ts", "--json"]);
    const parsed = JSON.parse(compared.stdout) as { readonly capabilities: ReadonlyArray<{ readonly resource: string; readonly kind: string; readonly provider: string; readonly requirements: ReadonlyArray<{ readonly capability: string; readonly support: string }> }>; readonly bindings: { readonly name: string } };
    expect(parsed.bindings.name).toBe("broken");
    expect(parsed.capabilities.find(entry => entry.resource === "audit")).toEqual({
      resource: "audit",
      kind: "queue",
      provider: "send-only",
      requirements: [{ capability: "queue", support: "native" }, { capability: "queue.delivery.at-least-once", support: "native" }, { capability: "trigger.queue.message", support: "native" }]
    });
  });

  it("requires --capabilities for --bindings and rejects combining it with --cycles", async () => {
    expect((await run(["inspect", "--bindings", "bindings.ts"])).code).toBe(2);
    expect((await run(["inspect", "--cycles", "--capabilities"])).code).toBe(2);
  });
});