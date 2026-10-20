import type { JsonObject } from "@/json";

// The telemetry data model a runtime produces and exporters consume. It
// mirrors the OpenTelemetry data model (spans, metrics, log records, resource)
// closely enough that an OTLP exporter is a mechanical translation, without
// depending on any OpenTelemetry package. Times are epoch milliseconds,
// possibly fractional.

/** A telemetry attribute value: a scalar or a homogeneous array of scalars, as OpenTelemetry allows. */
export type TelemetryAttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

/** Attributes of a span, metric point or resource. Keys follow OpenTelemetry semantic conventions where one exists. */
export interface TelemetryAttributes {
  readonly [key: string]: TelemetryAttributeValue;
}

/**
 * The role of a span in a trace, as in OpenTelemetry: `server` for an
 * incoming request, `consumer` for processing a message or event,
 * `producer` for publishing one, `client` for a call to another service or
 * resource, `internal` for everything else.
 */
export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

/** Whether a span's operation succeeded. `unset` means the instrumentation made no claim. */
export type SpanStatus
  = | { readonly code: "unset" | "ok" }
    | {
      readonly code: "error";
      /** A short, operator-safe description. */
      readonly message?: string;
    };

/**
 * A reference from one span to another span that is causally related but not
 * its parent, for example from a message's processing span to the span that
 * published the message.
 */
export interface SpanLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes?: TelemetryAttributes;
}

/** Something that happened at one point during a span, for example an exception. */
export interface SpanEvent {
  readonly name: string;
  /** Epoch milliseconds. */
  readonly time: number;
  readonly attributes?: TelemetryAttributes;
}

/** One finished span, ready to export. */
export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  /** The parent span; absent for the root span of a trace. */
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  /** Epoch milliseconds. */
  readonly startTime: number;
  /** Epoch milliseconds. */
  readonly endTime: number;
  readonly status: SpanStatus;
  readonly attributes: TelemetryAttributes;
  readonly events: readonly SpanEvent[];
  readonly links: readonly SpanLink[];
}

/** One data point of a monotonic counter or a sum, cumulative since `startTime`. */
export interface SumPoint {
  readonly attributes: TelemetryAttributes;
  /** When accumulation started, epoch milliseconds. */
  readonly startTime: number;
  /** When the point was collected, epoch milliseconds. */
  readonly time: number;
  readonly value: number;
}

/** One data point of a histogram with explicit bucket boundaries, cumulative since `startTime`. */
export interface HistogramPoint {
  readonly attributes: TelemetryAttributes;
  readonly startTime: number;
  readonly time: number;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  /** Upper bucket boundaries, ascending; bucket `i` counts values `<= bounds[i]` and `> bounds[i - 1]`. */
  readonly bounds: readonly number[];
  /** `bounds.length + 1` counts; the last bucket holds values above every boundary. */
  readonly bucketCounts: readonly number[];
}

/** One observed value of a gauge. */
export interface GaugePoint {
  readonly attributes: TelemetryAttributes;
  readonly time: number;
  readonly value: number;
}

/** What every metric record describes. */
interface MetricRecordBase {
  /** The metric name, for example `holqa.handler.invocations`. */
  readonly name: string;
  readonly description: string;
  /** A UCUM unit, for example `s` or `{invocation}`. */
  readonly unit: string;
}

/** A cumulative sum: a monotonic counter (`monotonic: true`) or an up-down counter. */
export interface SumMetricRecord extends MetricRecordBase {
  readonly type: "sum";
  readonly monotonic: boolean;
  readonly points: readonly SumPoint[];
}

/** A cumulative histogram with explicit bucket boundaries. */
export interface HistogramMetricRecord extends MetricRecordBase {
  readonly type: "histogram";
  readonly points: readonly HistogramPoint[];
}

/** The latest values of a gauge. */
export interface GaugeMetricRecord extends MetricRecordBase {
  readonly type: "gauge";
  readonly points: readonly GaugePoint[];
}

/** One collected metric with its points, discriminated by `type`. */
export type MetricRecord = SumMetricRecord | HistogramMetricRecord | GaugeMetricRecord;

/** Log severities, from least to most severe. */
export type TelemetryLogSeverity = "debug" | "info" | "warn" | "error";

/** One structured log record, correlated with the span that was active when it was written. */
export interface TelemetryLogRecord {
  /** Epoch milliseconds. */
  readonly time: number;
  readonly severity: TelemetryLogSeverity;
  readonly body: string;
  /** Structured fields, already redacted. */
  readonly attributes: JsonObject;
  readonly traceId?: string;
  readonly spanId?: string;
}

/** Describes the entity that produced telemetry, for example `{ "service.name": "orders" }`. */
export interface TelemetryResource {
  readonly attributes: TelemetryAttributes;
}

/** What a runtime passes to every export call. */
export interface TelemetryExportOptions {
  /** Aborted when the call exceeded the runtime's export time limit; the batch is then counted as failed, and the exporter should stop working on it. */
  readonly signal: AbortSignal;
}

/**
 * Receives finished telemetry and sends it somewhere: an OTLP collector, a
 * local store, memory in a test. Every method is optional, so an exporter
 * can handle only some signals. A runtime calls exporters from a bounded
 * background buffer, never from an invocation; a method that rejects or
 * takes too long loses that batch and is reported, but never affects
 * invocations. Exporters should do their work asynchronously: a method that
 * blocks before its first `await` blocks the process's event loop.
 */
export interface TelemetryExporter {
  /** A short name for diagnostics, for example `otlp-http` or `local`. */
  readonly name: string;
  /** Exports finished spans; rejects when the batch could not be delivered. */
  readonly exportSpans?: (spans: readonly SpanRecord[], resource: TelemetryResource, options?: TelemetryExportOptions) => Promise<void>;
  /** Exports a collection of cumulative metrics; rejects when it could not be delivered. */
  readonly exportMetrics?: (metrics: readonly MetricRecord[], resource: TelemetryResource, options?: TelemetryExportOptions) => Promise<void>;
  /** Exports log records; rejects when the batch could not be delivered. */
  readonly exportLogs?: (logs: readonly TelemetryLogRecord[], resource: TelemetryResource, options?: TelemetryExportOptions) => Promise<void>;
  /** Releases the exporter's resources once the runtime has flushed everything. */
  readonly shutdown?: () => Promise<void>;
}