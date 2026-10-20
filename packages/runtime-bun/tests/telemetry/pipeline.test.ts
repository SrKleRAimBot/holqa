import type {
  SpanRecord,
  TelemetryExporter
} from "@holqa/core";

import type { ExportProblem } from "@/telemetry/pipeline";

import { recordingExporter } from "@test/support/telemetry";
import {
  describe,
  expect,
  it
} from "bun:test";

import { TelemetryPipeline } from "@/telemetry/pipeline";

/**
 * Builds a finished span.
 *
 * @param name - Distinguishes the span in assertions.
 * @returns A finished internal span.
 */
function span(name: string): SpanRecord {
  return { traceId: "a".repeat(32), spanId: "b".repeat(16), name, kind: "internal", startTime: 0, endTime: 1, status: { code: "unset" }, attributes: {}, events: [], links: [] };
}

/**
 * Creates a pipeline with small limits.
 *
 * @param exporters - Its exporters.
 * @param overrides - Limit overrides.
 * @param overrides.maxQueueSize - The buffer size.
 * @param overrides.exportTimeoutMs - The export time limit.
 * @returns The pipeline, its reported problems and its drops.
 */
function pipelineWith(exporters: readonly TelemetryExporter[], overrides: { readonly maxQueueSize?: number; readonly exportTimeoutMs?: number } = {}): { readonly pipeline: TelemetryPipeline; readonly problems: ExportProblem[]; readonly drops: Array<[string, string, number]> } {
  const problems: ExportProblem[] = [];
  const drops: Array<[string, string, number]> = [];
  const pipeline = new TelemetryPipeline({
    exporters,
    resource: { attributes: { "service.name": "test" } },
    limits: { maxQueueSize: overrides.maxQueueSize ?? 100, maxBatchSize: 100, flushIntervalMs: 60_000, metricIntervalMs: 60_000, exportTimeoutMs: overrides.exportTimeoutMs ?? 1_000 },
    collectMetrics: async () => [],
    onDrop: (signal, reason, count) => drops.push([signal, reason, count]),
    report: problem => problems.push(problem),
    monotonicNow: () => 0
  });
  return { pipeline, problems, drops };
}

describe("TelemetryPipeline", () => {
  it("exports buffered spans on flush", async () => {
    const exporter = recordingExporter();
    const { pipeline } = pipelineWith([exporter]);
    pipeline.addSpan(span("a"));
    pipeline.addSpan(span("b"));
    await pipeline.flush();
    expect(exporter.spans.map(record => record.name)).toEqual(["a", "b"]);
    expect(pipeline.stats()).toMatchObject({ spansRecorded: 2, spansDropped: 0, pending: 0 });
  });

  it("drops the newest spans when the buffer is full", async () => {
    const exporter = recordingExporter();
    const { pipeline, drops } = pipelineWith([exporter], { maxQueueSize: 2 });
    for (const name of ["a", "b", "c"])
      pipeline.addSpan(span(name));
    await pipeline.flush();
    expect(exporter.spans.map(record => record.name)).toEqual(["a", "b"]);
    expect(drops).toEqual([["spans", "buffer-full", 1]]);
    expect(pipeline.stats().spansDropped).toBe(1);
  });

  it("isolates a failing exporter and reports it once per minute", async () => {
    const healthy = recordingExporter("healthy");
    const failing: TelemetryExporter = { name: "down", exportSpans: async () => {
      throw new Error("connection refused");
    } };
    const { pipeline, problems, drops } = pipelineWith([failing, healthy]);
    pipeline.addSpan(span("a"));
    await pipeline.flush();
    pipeline.addSpan(span("b"));
    await pipeline.flush();
    expect(healthy.spans.map(record => record.name)).toEqual(["a", "b"]);
    expect(problems).toEqual([{ exporter: "down", signal: "spans", message: "connection refused", failures: 1 }]);
    // Another exporter received the spans, so nothing counts as dropped.
    expect(drops).toEqual([]);
    expect(pipeline.stats().exportFailures).toBe(2);
  });

  it("times out an exporter that never answers and counts the batch as dropped", async () => {
    const hanging: TelemetryExporter = { name: "hanging", exportSpans: () => new Promise(() => {}) };
    const { pipeline, problems, drops } = pipelineWith([hanging], { exportTimeoutMs: 20 });
    pipeline.addSpan(span("a"));
    await pipeline.flush();
    expect(problems[0]).toMatchObject({ exporter: "hanging", message: "timed out after 20 ms" });
    expect(drops).toEqual([["spans", "export-failed", 1]]);
  });

  it("aborts the signal of an export that exceeds its time limit", async () => {
    let aborted = false;
    const hanging: TelemetryExporter = { name: "hanging", exportSpans: (_spans, _resource, options) => new Promise(() => options?.signal.addEventListener("abort", () => {
      aborted = true;
    })) };
    const { pipeline } = pipelineWith([hanging], { exportTimeoutMs: 10 });
    pipeline.addSpan(span("a"));
    await pipeline.flush();
    expect(aborted).toBe(true);
  });

  it("exports a full batch on a later turn, never on the recording call", async () => {
    let exported = 0;
    const exporter: TelemetryExporter = { name: "count", exportSpans: async (spans) => {
      exported += spans.length;
    } };
    const pipeline = new TelemetryPipeline({ exporters: [exporter], resource: { attributes: {} }, limits: { maxQueueSize: 10, maxBatchSize: 2, flushIntervalMs: 60_000, metricIntervalMs: 60_000, exportTimeoutMs: 1_000 }, collectMetrics: async () => [], onDrop: () => {}, report: () => {}, monotonicNow: () => 0 });
    pipeline.addSpan(span("a"));
    pipeline.addSpan(span("b"));
    expect(exported).toBe(0);
    await Bun.sleep(5);
    expect(exported).toBe(2);
    await pipeline.shutdown(100);
  });

  it("flushes and shuts exporters down, then ignores new records", async () => {
    let shutdowns = 0;
    const exporter = { ...recordingExporter(), shutdown: async () => {
      shutdowns += 1;
    } };
    const { pipeline } = pipelineWith([exporter]);
    pipeline.addSpan(span("a"));
    await pipeline.shutdown(1_000);
    pipeline.addSpan(span("late"));
    await pipeline.flush();
    expect(exporter.spans.map(record => record.name)).toEqual(["a"]);
    expect(shutdowns).toBe(1);
  });
});