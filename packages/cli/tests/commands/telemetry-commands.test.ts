import type { ResourceDescriptorOf } from "@holqa/core";
import type { LocalTelemetryStore } from "@holqa/local";

import type { CliHost } from "@/analysis/host";
import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  frameworkMetrics,
  messageEnvelopeFormat
} from "@holqa/core";
import {
  createLocalEnvironment,
  createLocalTelemetryStore,
  openLocalTelemetryReader,
  readDeliveryHistory
} from "@holqa/local";
import {
  application,
  queue
} from "@test/support/descriptors";
import {
  compiledOutcome,
  fakeHost
} from "@test/support/fake-host";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import { exitCodes } from "@/exit-codes";
import { runCli } from "@/run";

/** Cleanups to run after each test. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup();
});

/** A trace identifier of the recorded trace. */
const traceId = "0af7651916cd43dd8448eb211c80319c";

/**
 * Creates a state directory with a telemetry store.
 *
 * @returns The directory and the store.
 */
function recorded(): { readonly stateDir: string; readonly store: LocalTelemetryStore } {
  const stateDir = mkdtempSync(join(tmpdir(), "holqa-cli-telemetry-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const store = createLocalTelemetryStore({ directory: stateDir });
  cleanups.push(() => store.close());
  return { stateDir, store };
}

/**
 * Creates a host that reads telemetry from disk; `--follow` waits are scripted.
 *
 * @param waits - What each wait reports: `false` while following, `true` to stop. Runs `beforeWait` first.
 * @param beforeWait - Runs before each wait, for example to write a new entry.
 * @returns A host backed by the real local telemetry store and state.
 */
async function telemetryHost(waits: readonly boolean[] = [true], beforeWait: () => void = () => {}): Promise<CliHost> {
  const answers = [...waits];
  return {
    ...fakeHost(await compiledOutcome()),
    telemetry: stateDir => openLocalTelemetryReader(stateDir),
    deliveryHistory: (stateDir, id) => readDeliveryHistory(stateDir, id),
    waitForStop: async () => {
      beforeWait();
      return answers.shift() ?? true;
    }
  };
}

/**
 * Runs the CLI and collects every write.
 *
 * @param argv - The arguments.
 * @param host - Provides telemetry, delivery history and scripted waits.
 * @returns The exit code and the writes to each stream.
 */
async function run(argv: string[], host: CliHost): Promise<{ readonly code: number; readonly stdout: string[]; readonly stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, { stdout: text => stdout.push(text), stderr: text => stderr.push(text) }, "1.2.3", host);
  return { code, stdout, stderr };
}

describe("holqa logs", () => {
  it("prints recent entries, filtered by level and handler, as text or JSON lines", async () => {
    const { stateDir, store } = recorded();
    store.writeLog({ level: "info", time: "2026-10-20T10:00:00.000Z", message: "invocation completed", handlerId: "orders.process", traceId });
    store.writeLog({ level: "error", time: "2026-10-20T10:00:01.000Z", message: "invocation failed", handlerId: "orders.process", code: "HOLQA_HANDLER_FAILED" });
    store.writeLog({ level: "warn", time: "2026-10-20T10:00:02.000Z", message: "slow", handlerId: "other" });
    store.flushLogs();
    const host = await telemetryHost();
    const text = await run(["logs", "--state-dir", stateDir, "--level", "warn", "--handler", "orders.process"], host);
    expect(text.code).toBe(exitCodes.success);
    expect(text.stdout).toHaveLength(1);
    expect(text.stdout[0]).toContain("invocation failed");
    expect(text.stdout[0]).toContain("HOLQA_HANDLER_FAILED");
    const lines = await run(["logs", "--state-dir", stateDir, "--json"], host);
    expect(lines.stdout.map(line => JSON.parse(line).message)).toEqual(["invocation completed", "invocation failed", "slow"]);
    expect(JSON.parse(lines.stdout[0]!)).toMatchObject({ traceId });
  });

  it("follows new entries until the process is asked to stop", async () => {
    const { stateDir, store } = recorded();
    store.writeLog({ level: "info", time: "2026-10-20T10:00:00.000Z", message: "first" });
    store.flushLogs();
    let written = 0;
    const host = await telemetryHost([false, false, true], () => {
      written += 1;
      store.writeLog({ level: "info", time: "2026-10-20T10:00:00.000Z", message: `new ${written}` });
      store.flushLogs();
    });
    const result = await run(["logs", "--follow", "--state-dir", stateDir, "--json"], host);
    expect(result.code).toBe(exitCodes.success);
    expect(result.stdout.map(line => JSON.parse(line).message)).toEqual(["first", "new 1", "new 2"]);
  });

  it("explains that nothing was recorded yet, and rejects invalid options", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "holqa-cli-telemetry-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const host = await telemetryHost();
    expect((await run(["logs", "--state-dir", stateDir], host)).stdout[0]).toStartWith("No log entries are recorded");
    const invalid = await run(["logs", "--state-dir", stateDir, "--level", "loud", "--json"], host);
    expect(invalid.code).toBe(exitCodes.usage);
    expect(JSON.parse(invalid.stderr[0]!).diagnostics[0].code).toBe("HOLQA_CLI_ARGUMENT_INVALID");
  });
});

describe("holqa traces", () => {
  it("lists traces and prints one as a tree, accepting an unambiguous prefix", async () => {
    const { stateDir, store } = recorded();
    const resource = { attributes: { "service.name": "shop" } };
    await store.exporter.exportSpans!([
      { traceId, spanId: "1111111111111111", name: "POST /api/orders", kind: "server", startTime: 1_000, endTime: 1_050, status: { code: "unset" }, attributes: {}, events: [], links: [] },
      { traceId, spanId: "2222222222222222", parentSpanId: "1111111111111111", name: "send orders", kind: "producer", startTime: 1_010, endTime: 1_012, status: { code: "unset" }, attributes: {}, events: [], links: [] },
      { traceId, spanId: "3333333333333333", parentSpanId: "2222222222222222", name: "process orders", kind: "consumer", startTime: 1_020, endTime: 1_045, status: { code: "error", message: "boom" }, attributes: { "error.type": "HOLQA_HANDLER_FAILED" }, events: [{ name: "exception", time: 1_040, attributes: { "exception.type": "Error", "exception.message": "boom" } }], links: [{ traceId, spanId: "2222222222222222" }] }
    ], resource);
    const host = await telemetryHost();
    const list = await run(["traces", "list", "--state-dir", stateDir], host);
    expect(list.stdout[0]).toContain(`${traceId}  1970-01-01 00:00:01.000      50 ms      3       1  POST /api/orders`);
    const json = await run(["traces", "list", "--state-dir", stateDir, "--json"], host);
    expect(JSON.parse(json.stdout[0]!)).toEqual({ traces: [{ traceId, name: "POST /api/orders", startTime: 1_000, durationMs: 50, spans: 3, errors: 1 }] });

    const tree = await run(["traces", "inspect", traceId.slice(0, 8), "--state-dir", stateDir], host);
    expect(tree.code).toBe(exitCodes.success);
    const lines = tree.stdout[0]!.split("\n");
    expect(lines[0]).toBe(`trace ${traceId}  3 spans  50 ms  1 error`);
    expect(lines[1]).toStartWith("POST /api/orders");
    expect(lines[2]).toStartWith("`- send orders");
    expect(lines[3]).toStartWith("   `- process orders");
    expect(lines[3]).toContain("error HOLQA_HANDLER_FAILED");
    expect(lines[4]).toContain("exception: Error: boom");
  });

  it("rejects an ambiguous trace identifier prefix", async () => {
    const { stateDir, store } = recorded();
    const span = { spanId: "1111111111111111", name: "a", kind: "internal" as const, startTime: 0, endTime: 1, status: { code: "unset" as const }, attributes: {}, events: [], links: [] };
    await store.exporter.exportSpans!([{ ...span, traceId: `ab${"1".repeat(30)}` }, { ...span, traceId: `ab${"2".repeat(30)}` }], { attributes: {} });
    const result = await run(["traces", "inspect", "ab", "--state-dir", stateDir, "--json"], await telemetryHost());
    expect(result.code).toBe(exitCodes.usage);
    expect(JSON.parse(result.stderr[0]!).diagnostics[0].code).toBe("HOLQA_CLI_ARGUMENT_INVALID");
  });

  it("reports a store written by a newer version as a diagnostic instead of crashing", async () => {
    const { stateDir, store } = recorded();
    store.close();
    const { Database } = await import("bun:sqlite");
    const raw = new Database(join(stateDir, "telemetry.sqlite"));
    raw.run("PRAGMA user_version = 99");
    raw.close();
    const result = await run(["traces", "list", "--state-dir", stateDir, "--json"], await telemetryHost());
    expect(result.code).toBe(exitCodes.failure);
    expect(JSON.parse(result.stderr[0]!).diagnostics[0].code).toBe("HOLQA_LOCAL_STATE_UNSUPPORTED");
  });

  it("reports an unknown trace with HOLQA_TELEMETRY_NOT_FOUND", async () => {
    const { stateDir } = recorded();
    const result = await run(["traces", "inspect", "abcdef", "--state-dir", stateDir, "--json"], await telemetryHost());
    expect(result.code).toBe(exitCodes.failure);
    expect(JSON.parse(result.stderr[0]!).diagnostics[0].code).toBe("HOLQA_TELEMETRY_NOT_FOUND");
  });
});

describe("holqa events inspect", () => {
  it("combines the delivery's state and lineage with its invocations, logs and spans", async () => {
    const { stateDir, store } = recorded();
    const orders = queue("orders") as ResourceDescriptorOf<"queue">;
    const env = await createLocalEnvironment({ app: application("basic", [orders], []), directory: stateDir, env: {}, createId: () => "m-1" });
    cleanups.push(() => env.close());
    await env.binding.drivers.queue!(orders).send({ format: messageEnvelopeFormat, schemaVersion: 1, payload: {} }, {}, { trace: { correlationId: "c-1", causationId: "inv-1", rootId: "inv-1", depth: 1, traceparent: `00-${traceId}-2222222222222222-01` } });
    store.writeLog({ level: "info", time: "2026-10-20T10:00:00.000Z", message: "invocation failed", handlerId: "orders.process", invocationId: "inv-2", deliveryId: "m-1", attempt: 1, outcome: "failed", code: "HOLQA_HANDLER_FAILED", durationMs: 4, traceId });
    store.flushLogs();
    await store.exporter.exportSpans!([{ traceId, spanId: "3333333333333333", parentSpanId: "2222222222222222", name: "process orders", kind: "consumer", startTime: 1, endTime: 5, status: { code: "error" }, attributes: { "messaging.message.id": "m-1" }, events: [], links: [] }], { attributes: { "service.name": "basic" } });
    const host = await telemetryHost();
    const text = await run(["events", "inspect", "m-1", "--state-dir", stateDir], host);
    expect(text.code).toBe(exitCodes.success);
    const output = text.stdout[0]!;
    expect(output).toContain("queue orders: ready, 0 attempts");
    expect(output).toContain(`lineage: correlation c-1, caused by inv-1, root inv-1, depth 1, published in trace ${traceId}`);
    expect(output).toContain(`attempt 1  failed  HOLQA_HANDLER_FAILED  4 ms  inv-2  trace ${traceId}`);
    expect(output).toContain("process orders  consumer  4 ms  error");
    const json = JSON.parse((await run(["events", "inspect", "m-1", "--state-dir", stateDir, "--json"], host)).stdout[0]!);
    expect(json).toMatchObject({ id: "m-1", history: { deliveries: [{ kind: "queue.message", resourceId: "orders" }] }, invocations: [{ invocationId: "inv-2", attempt: 1, outcome: "failed" }], spans: [{ spanId: "3333333333333333" }] });
  });

  it("reports an unknown identifier with HOLQA_TELEMETRY_NOT_FOUND", async () => {
    const { stateDir } = recorded();
    const result = await run(["events", "inspect", "missing", "--state-dir", stateDir], await telemetryHost());
    expect(result.code).toBe(exitCodes.failure);
    expect(result.stderr.join("\n")).toContain("HOLQA_TELEMETRY_NOT_FOUND");
  });
});

describe("holqa metrics", () => {
  it("prints counters, gauges and histogram summaries", async () => {
    const { stateDir, store } = recorded();
    await store.exporter.exportMetrics!([
      { type: "sum", monotonic: true, name: "holqa.handler.invocations", description: "", unit: "{invocation}", points: [{ attributes: { "holqa.handler.id": "orders.process", "holqa.outcome": "ok" }, startTime: 0, time: 1, value: 3 }] },
      { type: "histogram", name: "holqa.handler.duration", description: "", unit: "s", points: [{ attributes: { "holqa.handler.id": "orders.process" }, startTime: 0, time: 1, count: 4, sum: 0.04, min: 0.004, max: 0.02, bounds: [0.005, 0.01, 0.025], bucketCounts: [1, 2, 1, 0] }] }
    ], { attributes: { "service.name": "basic", "service.instance.id": "i-1" } });
    store.increment(frameworkMetrics.reloadFailures, { "holqa.reload.stage": "build" });
    const host = await telemetryHost();
    const text = (await run(["metrics", "--state-dir", stateDir], host)).stdout[0]!;
    expect(text).toContain("holqa.dev.reload.failures (counter, {reload})\n  holqa.reload.stage=build  1");
    expect(text).toContain("holqa.handler.duration (histogram, s)\n  holqa.handler.id=orders.process  count 4  avg 10 ms  p50 <= 10 ms  p95 <= 20 ms  max 20 ms");
    expect(text).toContain("holqa.handler.invocations (counter, {invocation})\n  holqa.handler.id=orders.process holqa.outcome=ok  3");
    const json = JSON.parse((await run(["metrics", "--state-dir", stateDir, "--json"], host)).stdout[0]!);
    expect(json.metrics.map((metric: { name: string }) => metric.name)).toEqual(["holqa.dev.reload.failures", "holqa.handler.duration", "holqa.handler.invocations"]);
  });
});