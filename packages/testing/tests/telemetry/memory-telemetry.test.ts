import type { SpanRecord } from "@holqa/core";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  createMemoryTelemetry,
  spanTree
} from "@/telemetry/memory-telemetry";

/**
 * Builds a finished span.
 *
 * @param spanId - Its identifier, as one repeated digit.
 * @param name - Distinguishes it in assertions.
 * @param parent - Its parent's identifier digit, if any.
 * @param startTime - When it started.
 * @returns A finished internal span named after its role.
 */
function span(spanId: string, name: string, parent: string | undefined, startTime: number): SpanRecord {
  return { traceId: "a".repeat(32), spanId: spanId.repeat(16), ...parent === undefined ? {} : { parentSpanId: parent.repeat(16) }, name, kind: "internal", startTime, endTime: startTime + 1, status: { code: name === "fail" ? "error" : "unset" }, attributes: { "holqa.handler.id": name }, events: [], links: [] };
}

describe("createMemoryTelemetry", () => {
  it("records spans and the latest metrics, and answers filtered queries", async () => {
    const memory = createMemoryTelemetry();
    const resource = { attributes: { "service.name": "shop" } };
    await memory.exporter.exportSpans!([span("1", "root", undefined, 0), span("2", "child", "1", 1)], resource);
    await memory.exporter.exportMetrics!([{ type: "sum", monotonic: true, name: "holqa.handler.invocations", description: "", unit: "1", points: [{ attributes: { "holqa.outcome": "ok", "holqa.handler.id": "a" }, startTime: 0, time: 1, value: 2 }, { attributes: { "holqa.outcome": "failed", "holqa.handler.id": "a" }, startTime: 0, time: 1, value: 1 }] }], resource);
    expect(memory.spans({ attributes: { "holqa.handler.id": "child" } }).map(record => record.name)).toEqual(["child"]);
    expect(memory.metric("holqa.handler.invocations")).toBe(3);
    expect(memory.metric("holqa.handler.invocations", { "holqa.outcome": "failed" })).toBe(1);
    expect(memory.metric("missing")).toBe(0);
    expect(memory.resource()).toEqual(resource);
    memory.clear();
    expect(memory.spans()).toEqual([]);
  });
});

describe("spanTree", () => {
  it("nests spans under their parents in start order and treats orphans as roots", () => {
    expect(spanTree([span("3", "fail", "1", 5), span("1", "root", undefined, 0), span("2", "child", "1", 1), span("4", "orphan", "9", 2)])).toEqual([
      { name: "root", kind: "internal", status: "ok", children: [
        { name: "child", kind: "internal", status: "ok", children: [] },
        { name: "fail", kind: "internal", status: "error", children: [] }
      ] },
      { name: "orphan", kind: "internal", status: "ok", children: [] }
    ]);
  });
});