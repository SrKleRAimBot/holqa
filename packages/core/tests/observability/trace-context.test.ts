import {
  describe,
  expect,
  it
} from "bun:test";

import {
  formatTraceparent,
  isSpanId,
  isTraceId,
  parseTraceparent,
  randomSpanId,
  randomTraceId
} from "@/observability/trace-context";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const spanId = "00f067aa0ba902b7";

describe("parseTraceparent", () => {
  it("reads a sampled and an unsampled context", () => {
    expect(parseTraceparent(`00-${traceId}-${spanId}-01`)).toEqual({ traceId, spanId, sampled: true });
    expect(parseTraceparent(`00-${traceId}-${spanId}-00`)).toEqual({ traceId, spanId, sampled: false });
  });

  it("reads a future version by its first four fields", () => {
    expect(parseTraceparent(`01-${traceId}-${spanId}-01-future`)).toEqual({ traceId, spanId, sampled: true });
  });

  it("keeps a short printable tracestate", () => {
    expect(parseTraceparent(`00-${traceId}-${spanId}-01`, "vendor=abc")).toEqual({ traceId, spanId, sampled: true, traceState: "vendor=abc" });
    expect(parseTraceparent(`00-${traceId}-${spanId}-01`, "x".repeat(600))).toEqual({ traceId, spanId, sampled: true });
  });

  it.each([
    ["the invalid version ff", `ff-${traceId}-${spanId}-01`],
    ["an all-zero trace identifier", `00-${"0".repeat(32)}-${spanId}-01`],
    ["an all-zero span identifier", `00-${traceId}-${"0".repeat(16)}-01`],
    ["uppercase hexadecimal", `00-${traceId.toUpperCase()}-${spanId}-01`],
    ["extra fields", `00-${traceId}-${spanId}-01-extra`],
    ["a truncated value", `00-${traceId}-${spanId}`],
    ["a non-string", 42]
  ])("rejects %s", (_name, value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });
});

describe("formatTraceparent", () => {
  it("round-trips through parseTraceparent", () => {
    const context = { traceId, spanId, sampled: false };
    expect(formatTraceparent(context)).toBe(`00-${traceId}-${spanId}-00`);
    expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
  });
});

describe("random identifiers", () => {
  it("creates valid, distinct trace and span identifiers", () => {
    const traces = new Set(Array.from({ length: 50 }, randomTraceId));
    const spans = new Set(Array.from({ length: 50 }, randomSpanId));
    expect(traces.size).toBe(50);
    expect(spans.size).toBe(50);
    expect([...traces].every(isTraceId)).toBe(true);
    expect([...spans].every(isSpanId)).toBe(true);
  });
});