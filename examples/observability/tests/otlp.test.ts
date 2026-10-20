import type { LocalEnvironment } from "@holqa/local";
import type { LogEntry } from "@holqa/runtime-bun";
import type { FakeCollector } from "@/tests/support/collector";

import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalEnvironment } from "@holqa/local";
import { createOtlpHttpExporter } from "@holqa/opentelemetry";
import { createRuntime } from "@holqa/runtime-bun";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";
import app from "@/app/infra";
import {
  chargeOrder,
  placeOrder,
  receiptStored
} from "@/app/src/orders.handler";
import { startCollector } from "@/tests/support/collector";

/** Cleanups to run after each test, in reverse order. */
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup();
});

/**
 * Starts the application on a local environment with telemetry exported over OTLP/HTTP.
 *
 * @param endpoint - The OTLP receiver.
 * @returns The runtime, its environment and its log entries.
 */
async function startWith(endpoint: string): Promise<{ readonly runtime: ReturnType<typeof createRuntime>; readonly local: LocalEnvironment; readonly logs: LogEntry[] }> {
  const directory = mkdtempSync(join(tmpdir(), "holqa-observability-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const local = await createLocalEnvironment({ app, directory, env: { PAYMENT_TOKEN: "pay-tok-7f3a9c" } });
  cleanups.push(() => local.close());
  const logs: LogEntry[] = [];
  const runtime = createRuntime({
    app,
    handlers: [placeOrder, chargeOrder, receiptStored],
    binding: local.binding,
    log: entry => logs.push(entry),
    telemetry: { exporters: [createOtlpHttpExporter({ endpoint, timeoutMs: 2_000 })], limits: { exportTimeoutMs: 3_000 } }
  });
  await runtime.start();
  cleanups.push(() => runtime.stop({ graceMs: 1_000 }));
  return { runtime, local, logs };
}

/**
 * Places one order and waits until everything it caused has run.
 *
 * @param runtime - The running application.
 * @param local - Its local environment.
 * @returns The HTTP status.
 */
async function placeOrderAndSettle(runtime: ReturnType<typeof createRuntime>, local: LocalEnvironment): Promise<number> {
  const response = await runtime.fetch(new Request("http://localhost/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: "o-1", amountCents: 990 }) }));
  await local.settle();
  return response.status;
}

describe("OTLP export", () => {
  it("delivers one correlated trace and the framework metrics to an OTLP/HTTP receiver", async () => {
    const collector: FakeCollector = startCollector();
    cleanups.push(() => collector.stop());
    const { runtime, local } = await startWith(collector.url);
    expect(await placeOrderAndSettle(runtime, local)).toBe(202);
    await runtime.telemetry.flush();

    const spans = collector.spans();
    const names = spans.map(span => span.name).sort();
    expect(names).toEqual(["POST /api/orders", "process orders", "process receipts", "put receipts", "send orders"]);
    // One trace: every span shares the server span's trace and has its parent in the trace.
    const server = spans.find(span => span.kind === 2)!;
    expect(new Set(spans.map(span => span.traceId))).toEqual(new Set([server.traceId]));
    const ids = new Set(spans.map(span => span.spanId));
    expect(spans.filter(span => span.parentSpanId !== undefined).every(span => ids.has(span.parentSpanId!))).toBe(true);
    expect(collector.metricNames()).toEqual(expect.arrayContaining(["holqa.handler.duration", "holqa.handler.invocations", "holqa.invocations.active", "holqa.queue.pending", "http.server.request.duration", "messaging.process.duration"]));
    expect(JSON.stringify(collector.requests)).not.toContain("pay-tok-7f3a9c");
  });

  it("keeps serving when the receiver is unavailable, and reports the failure", async () => {
    const collector = startCollector();
    const unreachable = collector.url;
    await collector.stop();
    const { runtime, local, logs } = await startWith(unreachable);
    expect(await placeOrderAndSettle(runtime, local)).toBe(202);
    await runtime.telemetry.flush();
    expect(local.storage.objects("receipts").map(object => object.key)).toEqual(["receipts/o-1.json"]);
    expect(logs.filter(entry => entry.message === "invocation completed")).toHaveLength(3);
    expect(logs.find(entry => entry.message === "telemetry export failed; the records were dropped")).toMatchObject({ level: "warn", code: "HOLQA_TELEMETRY_EXPORT_FAILED", exporter: "otlp-http" });
    expect(runtime.stats().telemetry.spansDropped).toBeGreaterThan(0);
  });
});