import type { FakeCollector } from "@/tests/support/collector";

import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  join
} from "node:path";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout
} from "bun:test";
import { startCollector } from "@/tests/support/collector";

// Every command runs the built CLI, which spawns analysis and application processes.
setDefaultTimeout(60_000);

/** This example's directory. */
const example = join(import.meta.dir, "..");

/** The built `holqa` binary, through the CLI package's public files. */
const bin = join(dirname(Bun.resolveSync("@holqa/cli/package.json", example)), "dist", "bin.js");

/** The state directory of this test file. */
let stateDir: string;

/** The OTLP receiver the CLI exports to. */
let collector: FakeCollector;

/**
 * Runs the built CLI asynchronously, so the in-process collector can answer.
 *
 * @param args - The arguments.
 * @returns The exit code and output.
 */
async function holqa(...args: string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn(["bun", bin, ...args, "--app", "app/infra.ts", "--state-dir", stateDir], {
    cwd: example,
    // The developer's own OTEL_* settings must not change the result.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OTEL_"))), PAYMENT_TOKEN: "pay-tok-7f3a9c", OTEL_EXPORTER_OTLP_ENDPOINT: collector.url, OTEL_SERVICE_NAME: "observability-cli" },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "holqa-observability-cli-"));
  collector = startCollector();
  const invoked = await holqa("invoke", "orders.charge", "--input", JSON.stringify({ orderId: "o-9", amountCents: 500 }), "--json");
  expect(invoked.code).toBe(0);
});

afterAll(async () => {
  await collector.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("the telemetry commands", () => {
  it("list the recorded trace and print it as a tree", async () => {
    const list = await holqa("traces", "list", "--json");
    expect(list.code).toBe(0);
    const { traces } = JSON.parse(list.stdout) as { traces: Array<{ traceId: string; name: string; spans: number }> };
    expect(traces).toMatchObject([{ name: "invoke orders.charge", spans: 2 }]);
    const tree = await holqa("traces", "inspect", traces[0]!.traceId.slice(0, 10));
    expect(tree.code).toBe(0);
    expect(tree.stdout).toContain("invoke orders.charge");
    expect(tree.stdout).toContain("`- put receipts");
  });

  it("print logs that identify the execution without the secret", async () => {
    const logs = await holqa("logs", "--json", "--handler", "orders.charge");
    expect(logs.code).toBe(0);
    const entries = logs.stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find(({ message }) => message === "charging with token [REDACTED]")).toMatchObject({ application: "observability", handlerId: "orders.charge", authorization: "[REDACTED]", traceId: expect.any(String), invocationId: expect.any(String) });
    expect(logs.stdout).not.toContain("pay-tok-7f3a9c");
  });

  it("print the framework metrics", async () => {
    const metrics = await holqa("metrics", "--json");
    expect(metrics.code).toBe(0);
    const names = (JSON.parse(metrics.stdout) as { metrics: Array<{ name: string }> }).metrics.map(metric => metric.name);
    expect(names).toEqual(expect.arrayContaining(["holqa.handler.duration", "holqa.handler.invocations"]));
  });

  it("export the same telemetry to an OTLP/HTTP receiver configured with OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    expect(collector.spans().map(span => span.name).sort()).toEqual(["invoke orders.charge", "put receipts"]);
    expect(JSON.stringify(collector.requests)).toContain("observability-cli");
    expect(JSON.stringify(collector.requests)).not.toContain("pay-tok-7f3a9c");
  });

  it("report an unknown event with HOLQA_TELEMETRY_NOT_FOUND", async () => {
    const result = await holqa("events", "inspect", "missing", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).diagnostics[0].code).toBe("HOLQA_TELEMETRY_NOT_FOUND");
  });
});