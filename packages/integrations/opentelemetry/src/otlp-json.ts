import type {
  JsonValue,
  MetricRecord,
  SpanKind,
  SpanRecord,
  TelemetryAttributes,
  TelemetryAttributeValue,
  TelemetryLogRecord,
  TelemetryLogSeverity,
  TelemetryResource
} from "@holqa/core";

// The OTLP/JSON encoding (OTLP specification 1.x, "JSON Protobuf Encoding"):
// the protobuf messages of the OTLP collector services in proto3 JSON form,
// except that trace and span identifiers are lowercase hexadecimal strings.
// 64-bit integers (timestamps, counts, `intValue`) are decimal strings and
// enums are numbers.

/** An OTLP `AnyValue` in JSON form. */
export type OtlpAnyValue
  = | { readonly stringValue: string }
    | { readonly boolValue: boolean }
    | { readonly intValue: string }
    | { readonly doubleValue: number }
    | { readonly arrayValue: { readonly values: readonly OtlpAnyValue[] } }
    | { readonly kvlistValue: { readonly values: readonly OtlpKeyValue[] } };

/** An OTLP `KeyValue` in JSON form. */
export interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

/** The instrumentation scope Holqa reports its telemetry under. */
export const otlpScope = Object.freeze({ name: "holqa" });

/** OTLP `Span.SpanKind` numbers. */
const spanKinds: Readonly<Record<SpanKind, number>> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };

/** OTLP `Status.StatusCode` numbers. */
const statusCodes = { unset: 0, ok: 1, error: 2 } as const;

/** OTLP `SeverityNumber` of each log severity: the first number of its range. */
const severityNumbers: Readonly<Record<TelemetryLogSeverity, number>> = { debug: 5, info: 9, warn: 13, error: 17 };

/** OTLP `AggregationTemporality.CUMULATIVE`. */
const cumulative = 2;

/**
 * Converts epoch milliseconds, possibly fractional, to OTLP's decimal
 * nanosecond string without losing precision to floating point.
 *
 * @param ms - Epoch milliseconds.
 * @returns Nanoseconds since the epoch, as a decimal string; `"0"` (unknown) for a non-finite time.
 */
export function toUnixNano(ms: number): string {
  // A non-finite time cannot be represented; 0 marks it as unknown, as OTLP does.
  if (!Number.isFinite(ms))
    return "0";
  const whole = Math.floor(ms);
  const fraction = Math.round((ms - whole) * 1_000_000);
  return (BigInt(whole) * 1_000_000n + BigInt(fraction)).toString();
}

/**
 * Encodes one attribute or JSON value as an OTLP `AnyValue`. Integers become
 * `intValue`, other numbers `doubleValue`; `null` becomes an empty string,
 * since OTLP attributes have no null.
 *
 * @param value - A scalar, array or JSON object.
 * @returns The equivalent OTLP value.
 */
export function toAnyValue(value: TelemetryAttributeValue | JsonValue): OtlpAnyValue {
  if (typeof value === "string")
    return { stringValue: value };
  if (typeof value === "boolean")
    return { boolValue: value };
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (value === null)
    return { stringValue: "" };
  if (Array.isArray(value))
    return { arrayValue: { values: (value as ReadonlyArray<TelemetryAttributeValue | JsonValue>).map(toAnyValue) } };
  return { kvlistValue: { values: toKeyValues(value as Readonly<Record<string, JsonValue>>) } };
}

/**
 * Encodes attributes or structured fields as OTLP `KeyValue`s.
 *
 * @param attributes - Attributes by key.
 * @returns The key-value list, in key order of the input.
 */
export function toKeyValues(attributes: TelemetryAttributes | Readonly<Record<string, JsonValue>>): OtlpKeyValue[] {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

/**
 * Encodes the resource.
 *
 * @param resource - The resource that produced the telemetry.
 * @returns The OTLP `Resource`.
 */
function toResource(resource: TelemetryResource): { readonly attributes: OtlpKeyValue[] } {
  return { attributes: toKeyValues(resource.attributes) };
}

/**
 * Encodes spans as an OTLP `ExportTraceServiceRequest`.
 *
 * @param spans - Finished spans.
 * @param resource - The resource that produced them.
 * @returns The request body, ready for `JSON.stringify`.
 */
export function encodeOtlpTraces(spans: readonly SpanRecord[], resource: TelemetryResource): object {
  return {
    resourceSpans: [{
      resource: toResource(resource),
      scopeSpans: [{
        scope: otlpScope,
        spans: spans.map(span => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId },
          name: span.name,
          kind: spanKinds[span.kind],
          startTimeUnixNano: toUnixNano(span.startTime),
          endTimeUnixNano: toUnixNano(span.endTime),
          attributes: toKeyValues(span.attributes),
          events: span.events.map(event => ({ timeUnixNano: toUnixNano(event.time), name: event.name, attributes: toKeyValues(event.attributes ?? {}) })),
          links: span.links.map(link => ({ traceId: link.traceId, spanId: link.spanId, attributes: toKeyValues(link.attributes ?? {}) })),
          status: { code: statusCodes[span.status.code], ...span.status.code === "error" && span.status.message !== undefined ? { message: span.status.message } : {} }
        }))
      }]
    }]
  };
}

/**
 * Encodes a number as an OTLP `NumberDataPoint` value.
 *
 * @param value - A measured number.
 * @returns `asInt` for safe integers, `asDouble` otherwise.
 */
function numberValue(value: number): { readonly asInt: string } | { readonly asDouble: number } {
  return Number.isSafeInteger(value) ? { asInt: String(value) } : { asDouble: value };
}

/**
 * Encodes metrics as an OTLP `ExportMetricsServiceRequest`, with cumulative
 * temporality for sums and histograms.
 *
 * @param metrics - Collected metrics.
 * @param resource - The resource that produced them.
 * @returns The request body, ready for `JSON.stringify`.
 */
export function encodeOtlpMetrics(metrics: readonly MetricRecord[], resource: TelemetryResource): object {
  return {
    resourceMetrics: [{
      resource: toResource(resource),
      scopeMetrics: [{
        scope: otlpScope,
        metrics: metrics.map((metric) => {
          const base = { name: metric.name, description: metric.description, unit: metric.unit };
          switch (metric.type) {
            case "sum":
              return { ...base, sum: { aggregationTemporality: cumulative, isMonotonic: metric.monotonic, dataPoints: metric.points.map(point => ({ attributes: toKeyValues(point.attributes), startTimeUnixNano: toUnixNano(point.startTime), timeUnixNano: toUnixNano(point.time), ...numberValue(point.value) })) } };
            case "histogram":
              return { ...base, histogram: { aggregationTemporality: cumulative, dataPoints: metric.points.map(point => ({ attributes: toKeyValues(point.attributes), startTimeUnixNano: toUnixNano(point.startTime), timeUnixNano: toUnixNano(point.time), count: String(point.count), sum: point.sum, min: point.min, max: point.max, explicitBounds: point.bounds, bucketCounts: point.bucketCounts.map(String) })) } };
            case "gauge":
              return { ...base, gauge: { dataPoints: metric.points.map(point => ({ attributes: toKeyValues(point.attributes), timeUnixNano: toUnixNano(point.time), ...numberValue(point.value) })) } };
          }
          return base;
        })
      }]
    }]
  };
}

/**
 * Encodes log records as an OTLP `ExportLogsServiceRequest`.
 *
 * @param logs - Log records, already redacted.
 * @param resource - The resource that produced them.
 * @returns The request body, ready for `JSON.stringify`.
 */
export function encodeOtlpLogs(logs: readonly TelemetryLogRecord[], resource: TelemetryResource): object {
  return {
    resourceLogs: [{
      resource: toResource(resource),
      scopeLogs: [{
        scope: otlpScope,
        logRecords: logs.map(record => ({
          timeUnixNano: toUnixNano(record.time),
          observedTimeUnixNano: toUnixNano(record.time),
          severityNumber: severityNumbers[record.severity],
          severityText: record.severity.toUpperCase(),
          body: { stringValue: record.body },
          attributes: toKeyValues(record.attributes),
          ...record.traceId === undefined ? {} : { traceId: record.traceId },
          ...record.spanId === undefined ? {} : { spanId: record.spanId }
        }))
      }]
    }]
  };
}