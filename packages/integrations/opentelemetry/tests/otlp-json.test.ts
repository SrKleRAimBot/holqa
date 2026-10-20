import type {
  MetricRecord,
  SpanRecord
} from "@holqa/core";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  encodeOtlpLogs,
  encodeOtlpMetrics,
  encodeOtlpTraces,
  toAnyValue,
  toUnixNano
} from "@/otlp-json";

/** The resource every test encodes. */
const resource = { attributes: { "service.name": "shop", "service.instance.id": "i-1" } };

describe("toUnixNano", () => {
  it("converts fractional epoch milliseconds to exact nanosecond strings", () => {
    expect(toUnixNano(0)).toBe("0");
    expect(toUnixNano(1_760_000_000_123)).toBe("1760000000123000000");
    expect(toUnixNano(1_760_000_000_123.25)).toBe("1760000000123250000");
  });
});

describe("toAnyValue", () => {
  it("maps scalars, arrays and objects to OTLP values", () => {
    expect(toAnyValue("a")).toEqual({ stringValue: "a" });
    expect(toAnyValue(3)).toEqual({ intValue: "3" });
    expect(toAnyValue(0.5)).toEqual({ doubleValue: 0.5 });
    expect(toAnyValue(true)).toEqual({ boolValue: true });
    expect(toAnyValue(["x"])).toEqual({ arrayValue: { values: [{ stringValue: "x" }] } });
    expect(toAnyValue({ k: null })).toEqual({ kvlistValue: { values: [{ key: "k", value: { stringValue: "" } }] } });
  });
});

describe("encodeOtlpTraces", () => {
  it("produces an ExportTraceServiceRequest with hexadecimal identifiers and numeric enums", () => {
    const span: SpanRecord = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      parentSpanId: "00f067aa0ba902b7",
      name: "process orders",
      kind: "consumer",
      startTime: 1_000,
      endTime: 1_002.5,
      status: { code: "error", message: "HOLQA_HANDLER_FAILED" },
      attributes: { "messaging.destination.name": "orders", "holqa.delivery.attempt": 2 },
      events: [{ name: "exception", time: 1_001, attributes: { "exception.message": "boom" } }],
      links: [{ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "1111111111111111" }]
    };
    expect(encodeOtlpTraces([span], resource)).toEqual({
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "shop" } }, { key: "service.instance.id", value: { stringValue: "i-1" } }] },
        scopeSpans: [{
          scope: { name: "holqa" },
          spans: [{
            traceId: "0af7651916cd43dd8448eb211c80319c",
            spanId: "b7ad6b7169203331",
            parentSpanId: "00f067aa0ba902b7",
            name: "process orders",
            kind: 5,
            startTimeUnixNano: "1000000000",
            endTimeUnixNano: "1002500000",
            attributes: [{ key: "messaging.destination.name", value: { stringValue: "orders" } }, { key: "holqa.delivery.attempt", value: { intValue: "2" } }],
            events: [{ timeUnixNano: "1001000000", name: "exception", attributes: [{ key: "exception.message", value: { stringValue: "boom" } }] }],
            links: [{ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "1111111111111111", attributes: [] }],
            status: { code: 2, message: "HOLQA_HANDLER_FAILED" }
          }]
        }]
      }]
    });
  });
});

describe("encodeOtlpMetrics", () => {
  it("encodes cumulative sums, histograms and gauges with 64-bit integers as strings", () => {
    const metrics: MetricRecord[] = [
      { type: "sum", monotonic: true, name: "holqa.handler.invocations", description: "d", unit: "{invocation}", points: [{ attributes: { "holqa.outcome": "ok" }, startTime: 1, time: 2, value: 4 }] },
      { type: "histogram", name: "holqa.handler.duration", description: "d", unit: "s", points: [{ attributes: {}, startTime: 1, time: 2, count: 2, sum: 0.3, min: 0.1, max: 0.2, bounds: [0.15], bucketCounts: [1, 1] }] },
      { type: "gauge", name: "holqa.queue.pending", description: "d", unit: "{message}", points: [{ attributes: {}, time: 2, value: 0.5 }] }
    ];
    const encoded = encodeOtlpMetrics(metrics, resource) as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: unknown[] }> }> };
    expect(encoded.resourceMetrics[0]!.scopeMetrics[0]!.metrics).toEqual([
      { name: "holqa.handler.invocations", description: "d", unit: "{invocation}", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ attributes: [{ key: "holqa.outcome", value: { stringValue: "ok" } }], startTimeUnixNano: "1000000", timeUnixNano: "2000000", asInt: "4" }] } },
      { name: "holqa.handler.duration", description: "d", unit: "s", histogram: { aggregationTemporality: 2, dataPoints: [{ attributes: [], startTimeUnixNano: "1000000", timeUnixNano: "2000000", count: "2", sum: 0.3, min: 0.1, max: 0.2, explicitBounds: [0.15], bucketCounts: ["1", "1"] }] } },
      { name: "holqa.queue.pending", description: "d", unit: "{message}", gauge: { dataPoints: [{ attributes: [], timeUnixNano: "2000000", asDouble: 0.5 }] } }
    ]);
  });
});

describe("encodeOtlpLogs", () => {
  it("encodes severity numbers, the body and trace correlation", () => {
    const encoded = encodeOtlpLogs([{ time: 5, severity: "warn", body: "slow", attributes: { handlerId: "h" }, traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" }], resource) as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }> };
    expect(encoded.resourceLogs[0]!.scopeLogs[0]!.logRecords).toEqual([{ timeUnixNano: "5000000", observedTimeUnixNano: "5000000", severityNumber: 13, severityText: "WARN", body: { stringValue: "slow" }, attributes: [{ key: "handlerId", value: { stringValue: "h" } }], traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" }]);
  });
});