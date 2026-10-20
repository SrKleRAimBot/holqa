import type {
  MetricRecord,
  SpanRecord,
  TelemetryResource
} from "@holqa/core";
import type { LogEntry } from "@holqa/runtime-bun";

import { frameworkMetrics } from "@holqa/core";
import { stateDirectory } from "@test/support/fixtures";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import { ManualClock } from "@/clock";
import {
  createLocalTelemetryStore,
  openLocalTelemetryReader
} from "@/telemetry/telemetry-store";

/** Cleanups to run after each test. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup();
});

/**
 * Creates a store in a temporary directory.
 *
 * @param retention - Retention overrides.
 * @returns The store, its directory and its clock.
 */
function storeWith(retention: Parameters<typeof createLocalTelemetryStore>[0]["retention"] = {}): { readonly store: ReturnType<typeof createLocalTelemetryStore>; readonly directory: string; readonly clock: ManualClock } {
  const directory = stateDirectory();
  cleanups.push(directory.remove);
  const clock = new ManualClock(Date.parse("2026-10-20T10:00:00.000Z"));
  const store = createLocalTelemetryStore({ directory: directory.path, clock, retention });
  cleanups.push(() => store.close());
  return { store, directory: directory.path, clock };
}

/**
 * Builds a span of one trace.
 *
 * @param traceId - The trace, as one repeated hexadecimal digit.
 * @param spanId - The span, as one repeated hexadecimal digit.
 * @param overrides - Fields to replace.
 * @returns A finished span.
 */
function span(traceId: string, spanId: string, overrides: Partial<SpanRecord> = {}): SpanRecord {
  return { traceId: traceId.repeat(32), spanId: spanId.repeat(16), name: `span ${spanId}`, kind: "internal", startTime: 1_000, endTime: 1_010, status: { code: "unset" }, attributes: {}, events: [], links: [], ...overrides };
}

/**
 * Builds the resource of one runtime instance.
 *
 * @param instance - The `service.instance.id`, which keeps instances' series apart.
 * @returns The resource of the `shop` service.
 */
function resource(instance: string): TelemetryResource {
  return { attributes: { "service.name": "shop", "service.instance.id": instance } };
}

/**
 * Builds a log entry.
 *
 * @param message - What it says.
 * @param fields - More fields.
 * @returns An info entry written at a fixed time.
 */
function entry(message: string, fields: Record<string, string> = {}): LogEntry {
  return { level: "info", time: "2026-10-20T10:00:00.000Z", message, ...fields };
}

describe("createLocalTelemetryStore", () => {
  it("stores spans and lists traces, newest first, with their root span's name", async () => {
    const { store } = storeWith();
    await store.exporter.exportSpans!([
      span("a", "2", { parentSpanId: "1".repeat(16), name: "send orders", startTime: 1_005, endTime: 1_006 }),
      span("a", "1", { name: "POST /api/orders", kind: "server", endTime: 1_040 }),
      span("b", "3", { status: { code: "error", message: "boom" }, attributes: { "messaging.message.id": "m-1" } })
    ], resource("i-1"));
    expect(store.traces()).toEqual([
      { traceId: "b".repeat(32), name: "span 3", startTime: 1_000, durationMs: 10, spans: 1, errors: 1 },
      { traceId: "a".repeat(32), name: "POST /api/orders", startTime: 1_000, durationMs: 40, spans: 2, errors: 0 }
    ]);
    expect(store.trace("a".repeat(32)).map(record => record.name)).toEqual(["POST /api/orders", "send orders"]);
    expect(store.spansOfDelivery("m-1").map(record => record.spanId)).toEqual(["3".repeat(16)]);
    expect(store.trace("c".repeat(32))).toEqual([]);
  });

  it("stores log entries and filters them by level, handler, trace and position", () => {
    const { store } = storeWith();
    store.writeLog(entry("one", { handlerId: "orders.process", traceId: "t-1" }));
    store.writeLog({ ...entry("two"), level: "error" });
    store.writeLog(entry("three", { handlerId: "orders.process", deliveryId: "m-1" }));
    // Entries are written in batches, off the caller's stack.
    expect(store.logs()).toEqual([]);
    store.flushLogs();
    expect(store.logs().map(stored => stored.entry.message)).toEqual(["one", "two", "three"]);
    expect(store.logs({ limit: 2 }).map(stored => stored.entry.message)).toEqual(["two", "three"]);
    expect(store.logs({ level: "warn" }).map(stored => stored.entry.message)).toEqual(["two"]);
    expect(store.logs({ handlerId: "orders.process", traceId: "t-1" }).map(stored => stored.entry.message)).toEqual(["one"]);
    expect(store.logs({ deliveryId: "m-1" }).map(stored => stored.entry.message)).toEqual(["three"]);
    const [first] = store.logs({ limit: 1, after: 0 });
    expect(store.logs({ after: first!.seq }).map(stored => stored.entry.message)).toEqual(["two", "three"]);
  });

  it("adds up cumulative metrics across runtime instances and keeps the latest gauge", async () => {
    const { store, clock } = storeWith();
    /**
     * Builds one collection.
     *
     * @param count - The counter's value.
     * @param pending - The gauge's value.
     * @returns The metrics.
     */
    const collection = (count: number, pending: number): MetricRecord[] => [
      { type: "sum", monotonic: true, name: "holqa.handler.invocations", description: "", unit: "{invocation}", points: [{ attributes: { "holqa.handler.id": "a" }, startTime: 0, time: 1, value: count }] },
      { type: "gauge", name: "holqa.queue.pending", description: "", unit: "{message}", points: [{ attributes: { "messaging.destination.name": "jobs" }, time: 1, value: pending }] }
    ];
    await store.exporter.exportMetrics!(collection(2, 5), resource("i-1"));
    clock.advance(1_000);
    await store.exporter.exportMetrics!(collection(3, 1), resource("i-2"));
    clock.advance(1_000);
    // A later collection of the same instance replaces its earlier one.
    await store.exporter.exportMetrics!(collection(4, 7), resource("i-1"));
    store.increment(frameworkMetrics.reloadFailures, { "holqa.reload.stage": "analyze" });
    store.increment(frameworkMetrics.reloadFailures, { "holqa.reload.stage": "analyze" });
    const metrics = store.metrics();
    expect(metrics.map(metric => metric.name)).toEqual(["holqa.dev.reload.failures", "holqa.handler.invocations", "holqa.queue.pending"]);
    expect(metrics.map(metric => (metric.points[0] as { value: number }).value)).toEqual([2, 7, 7]);
  });

  it("deletes the oldest telemetry beyond its retention", () => {
    const { store } = storeWith({ maxLogs: 50 });
    for (let index = 0; index < 400; index += 1) {
      store.writeLog(entry(`entry ${index}`));
      if (index % 100 === 99)
        store.flushLogs();
    }
    const kept = store.logs({ limit: 1_000 });
    expect(kept.length).toBeLessThanOrEqual(250);
    expect(kept.at(-1)?.entry.message).toBe("entry 399");
  });

  it("is readable without changing anything, and absent before anything was recorded", async () => {
    const { store, directory } = storeWith();
    store.writeLog(entry("kept"));
    store.flushLogs();
    const reader = openLocalTelemetryReader(directory)!;
    cleanups.push(() => reader.close());
    expect(reader.logs().map(stored => stored.entry.message)).toEqual(["kept"]);
    const empty = stateDirectory();
    cleanups.push(empty.remove);
    expect(openLocalTelemetryReader(empty.path)).toBeUndefined();
  });

  it("skips damaged rows instead of failing", async () => {
    const { store, directory } = storeWith();
    store.writeLog(entry("kept"));
    store.flushLogs();
    const { Database } = await import("bun:sqlite");
    const raw = new Database(`${directory}/telemetry.sqlite`);
    raw.run("INSERT INTO logs (time, level, entry) VALUES (0, 'info', 'not json')");
    raw.run("INSERT INTO spans (trace_id, span_id, name, start_time, end_time, status, service, record) VALUES ('t', 's', 'n', 0, 0, 'unset', 'x', '{\"traceId\":\"bad\"}')");
    raw.run("INSERT INTO metrics (instance, service, name, series, updated_at, record) VALUES ('i', 's', 'm', '{}', 0, '{\"name\":\"m\",\"type\":\"sum\",\"points\":[{}]}')");
    raw.close();
    expect(store.logs().map(stored => stored.entry.message)).toEqual(["kept"]);
    expect(store.trace("t")).toEqual([]);
    expect(store.metrics()).toEqual([]);
  });

  it("writes queued log entries when it is closed", () => {
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    const store = createLocalTelemetryStore({ directory: directory.path });
    store.writeLog(entry("last words"));
    store.close();
    const reader = openLocalTelemetryReader(directory.path)!;
    cleanups.push(() => reader.close());
    expect(reader.logs().map(stored => stored.entry.message)).toEqual(["last words"]);
  });

  it("rejects invalid retention settings", () => {
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    expect(() => createLocalTelemetryStore({ directory: directory.path, retention: { maxSpans: 0 } })).toThrow(expect.objectContaining({ code: "HOLQA_DECLARATION_INVALID" }));
  });
});