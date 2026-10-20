import type { CliHost } from "@/analysis/host";

import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout
} from "bun:test";

import { createProcessHost } from "@/analysis/process-host";
import { runCli } from "@/run";

// Every test spawns an analysis process and a provisioning process.
setDefaultTimeout(30_000);

const { PATH } = process.env;
const root = join(import.meta.dir, "..", "fixtures", "apps", "bound");
let directory = "";
let stateFile = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "holqa-provision-"));
  stateFile = join(directory, "state.json");
  Object.assign(process.env, { FIXTURE_STATE_FILE: stateFile, FIXTURE_ADMIN_TOKEN: "fixture-admin-token" });
});

afterEach(async () => {
  Reflect.deleteProperty(process.env, "FIXTURE_STATE_FILE");
  Reflect.deleteProperty(process.env, "FIXTURE_ADMIN_TOKEN");
  await rm(directory, { recursive: true, force: true });
});

/**
 * Runs the CLI against the fixture with a process host.
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

describe("holqa provision", () => {
  it("plans without changing anything, applies, and then plans no changes", async () => {
    const plan = await run(["provision", "plan"]);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain("+ create  example.queue audit");
    expect(plan.stdout).toContain("+ create  example.queue orders");
    expect(await Bun.file(stateFile).exists()).toBe(false);
    const apply = await run(["provision", "apply", "--json"]);
    expect(apply.code).toBe(0);
    const { result } = JSON.parse(apply.stdout) as { readonly result: { readonly applied: ReadonlyArray<{ readonly status: string }> } };
    expect(result.applied.map(item => item.status)).toEqual(["applied", "applied"]);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({ audit: "ok", orders: "ok" });
    expect((await run(["provision", "plan"])).stdout).toContain("No changes: the infrastructure is as needed.");
  });

  it("applies nothing with a destructive change unless --allow-destructive is given", async () => {
    await writeFile(stateFile, JSON.stringify({ audit: "conflict" }));
    const refused = await run(["provision", "apply", "--json"]);
    expect(refused.code).toBe(1);
    expect((JSON.parse(refused.stdout) as { readonly result: { readonly diagnostics: ReadonlyArray<{ readonly code: string }> } }).result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_PROVISIONING_DESTRUCTIVE"]);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({ audit: "conflict" });
    expect((await run(["provision", "apply"])).stdout).toContain("Nothing was applied.");
    expect((await run(["provision", "apply", "--allow-destructive"])).code).toBe(0);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({ audit: "ok", orders: "ok" });
  });

  it("reports a missing credential by name, a missing module, and a misplaced flag", async () => {
    Reflect.deleteProperty(process.env, "FIXTURE_ADMIN_TOKEN");
    const missing = await run(["provision", "plan", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain("HOLQA_BINDING_CREDENTIALS_MISSING");
    expect(missing.stdout).not.toContain("fixture-admin-token");
    const noModule = await run(["provision", "plan", "--provisioning", "nope.ts", "--json"]);
    expect(JSON.parse(noModule.stderr)).toMatchObject({ diagnostics: [{ code: "HOLQA_FILE_UNREADABLE" }] });
    expect((await run(["provision", "plan", "--allow-destructive"])).code).toBe(2);
  });
});