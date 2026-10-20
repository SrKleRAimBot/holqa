import type { SpanRecord } from "@holqa/core";

import { createRedactor } from "@holqa/core";
import { sequentialTelemetryIds } from "@test/support/telemetry";
import {
  describe,
  expect,
  it
} from "bun:test";

import { Tracer } from "@/telemetry/tracer";

/**
 * Creates a tracer whose ended spans are collected.
 *
 * @param sampleRatio - The sampling ratio.
 * @returns The tracer and the ended spans.
 */
function tracerWith(sampleRatio = 1): { readonly tracer: Tracer; readonly ended: SpanRecord[] } {
  const ended: SpanRecord[] = [];
  let monotonic = 0;
  const tracer = new Tracer({ sampleRatio, ids: sequentialTelemetryIds(), wallNow: () => 1_000, monotonicNow: () => (monotonic += 5), redactor: createRedactor({ values: ["hunter22"] }), onEnd: span => ended.push(span) });
  return { tracer, ended };
}

describe("Tracer", () => {
  it("records a child span in its parent's trace with its duration", () => {
    const { tracer, ended } = tracerWith();
    const root = tracer.startSpan({ name: "root", kind: "server" });
    const child = tracer.startSpan({ name: "child", kind: "producer", parent: root.context });
    child.end();
    root.end();
    expect(ended.map(span => span.name)).toEqual(["child", "root"]);
    expect(ended[0]).toMatchObject({ traceId: root.context.traceId, parentSpanId: root.context.spanId, kind: "producer", startTime: 1_000 });
    expect(ended[0]!.endTime).toBeGreaterThan(ended[0]!.startTime);
    expect(ended[1]!.parentSpanId).toBeUndefined();
  });

  it("follows the parent's sampling decision and records nothing for unsampled spans", () => {
    const { tracer, ended } = tracerWith(1);
    const span = tracer.startSpan({ name: "continued", kind: "server", parent: { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: false } });
    expect(span.context.sampled).toBe(false);
    expect(span.traceparent).toBe(`00-${"a".repeat(32)}-${span.context.spanId}-00`);
    span.setAttribute("ignored", true);
    span.end();
    expect(ended).toEqual([]);
  });

  it("samples new traces by ratio", () => {
    expect(tracerWith(0).tracer.startSpan({ name: "x", kind: "internal" }).context.sampled).toBe(false);
    expect(tracerWith(1).tracer.startSpan({ name: "x", kind: "internal" }).context.sampled).toBe(true);
  });

  it("redacts attributes, events and status when the span ends, and ends once", () => {
    const { tracer, ended } = tracerWith();
    const span = tracer.startSpan({ name: "op", kind: "internal", attributes: { "db.password": "x", "note": "uses hunter22" } });
    span.recordException(new Error("login with hunter22 failed"));
    span.setStatus({ code: "error", message: "hunter22 rejected" });
    span.end();
    span.end();
    expect(ended).toHaveLength(1);
    expect(ended[0]!.attributes).toEqual({ "db.password": "[REDACTED]", "note": "uses [REDACTED]" });
    expect(ended[0]!.events[0]).toMatchObject({ name: "exception", attributes: { "exception.type": "Error", "exception.message": "login with [REDACTED] failed" } });
    expect(ended[0]!.status).toEqual({ code: "error", message: "[REDACTED] rejected" });
  });
});