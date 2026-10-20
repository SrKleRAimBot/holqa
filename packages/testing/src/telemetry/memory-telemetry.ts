import type {
  MetricRecord,
  SpanKind,
  SpanRecord,
  TelemetryAttributes,
  TelemetryExporter,
  TelemetryLogRecord,
  TelemetryResource
} from "@holqa/core";

/** Which spans {@link MemoryTelemetry.spans} returns. */
export interface SpanFilter {
  readonly name?: string;
  readonly kind?: SpanKind;
  readonly traceId?: string;
  /** Only spans whose attributes include these values. */
  readonly attributes?: TelemetryAttributes;
}

/** One span and its children, as {@link spanTree} builds them. */
export interface SpanNode {
  readonly name: string;
  readonly kind: SpanKind;
  /** `ok` unless the span's status is `error`. */
  readonly status: "ok" | "error";
  readonly children: readonly SpanNode[];
}

/**
 * Telemetry recorded in memory, for assertions in tests. Spans and log
 * records accumulate; metrics keep the latest collection, which is
 * cumulative since the runtime started.
 */
export interface MemoryTelemetry {
  /** Pass it to `createRuntime({ telemetry: { exporters: [memory.exporter] } })`. */
  readonly exporter: TelemetryExporter;
  /** The resource of the most recent export, for example to check `service.name`. */
  readonly resource: () => TelemetryResource | undefined;
  /** Exported spans in end order, optionally filtered. */
  readonly spans: (filter?: SpanFilter) => SpanRecord[];
  /** Every exported span of one trace, by start time. */
  readonly trace: (traceId: string) => SpanRecord[];
  /** Exported log records, in order. */
  readonly logs: () => TelemetryLogRecord[];
  /** The latest metric collection. */
  readonly metrics: () => MetricRecord[];
  /**
   * The value of a counter or gauge series, or the count of a histogram
   * series, in the latest collection: the sum over every series whose
   * attributes include `attributes`. 0 when nothing matches.
   */
  readonly metric: (name: string, attributes?: TelemetryAttributes) => number;
  /** Forgets everything recorded so far. */
  readonly clear: () => void;
}

/**
 * Reports whether a set of attributes includes every expected value.
 *
 * @param actual - The span's or point's attributes.
 * @param expected - The values that must be present.
 * @returns `true` when every expected key has an equal value.
 */
function includes(actual: TelemetryAttributes, expected: TelemetryAttributes | undefined): boolean {
  return Object.entries(expected ?? {}).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value));
}

/**
 * Creates telemetry that is recorded in memory, for tests.
 *
 * @example
 * ```ts
 * const memory = createMemoryTelemetry();
 * const runtime = createRuntime({ app, handlers, telemetry: { exporters: [memory.exporter] } });
 * // ... run work, then:
 * await runtime.telemetry.flush();
 * expect(memory.spans({ kind: "consumer" })).toHaveLength(1);
 * ```
 *
 * @returns The exporter and the recorded telemetry.
 */
export function createMemoryTelemetry(): MemoryTelemetry {
  let spans: SpanRecord[] = [];
  let logs: TelemetryLogRecord[] = [];
  let metrics: MetricRecord[] = [];
  let resource: TelemetryResource | undefined;
  return Object.freeze({
    exporter: Object.freeze({
      name: "memory",
      exportSpans: async (batch: readonly SpanRecord[], from: TelemetryResource) => {
        resource = from;
        spans = [...spans, ...batch];
      },
      exportMetrics: async (collection: readonly MetricRecord[], from: TelemetryResource) => {
        resource = from;
        metrics = [...collection];
      },
      exportLogs: async (batch: readonly TelemetryLogRecord[], from: TelemetryResource) => {
        resource = from;
        logs = [...logs, ...batch];
      }
    }),
    resource: () => resource,
    spans: (filter: SpanFilter = {}) => spans.filter(span =>
      (filter.name === undefined || span.name === filter.name)
      && (filter.kind === undefined || span.kind === filter.kind)
      && (filter.traceId === undefined || span.traceId === filter.traceId)
      && includes(span.attributes, filter.attributes)),
    trace: (traceId: string) => spans.filter(span => span.traceId === traceId).sort((left, right) => left.startTime - right.startTime),
    logs: () => [...logs],
    metrics: () => [...metrics],
    metric: (name: string, attributes?: TelemetryAttributes) => {
      const record = metrics.find(candidate => candidate.name === name);
      if (record === undefined)
        return 0;
      return record.points.filter(point => includes(point.attributes, attributes)).reduce((total, point) => total + ("count" in point ? point.count : point.value), 0);
    },
    clear: () => {
      spans = [];
      logs = [];
      metrics = [];
    }
  });
}

/**
 * Arranges spans as trees of names and kinds, children in start order, so a
 * test can assert the causal structure of a trace without identifiers or
 * times. Spans whose parent is not among them become roots.
 *
 * @example
 * ```ts
 * expect(spanTree(memory.trace(traceId))).toEqual([
 *   { name: "POST /api/orders", kind: "server", status: "ok", children: [
 *     { name: "send orders", kind: "producer", status: "ok", children: [
 *       { name: "process orders", kind: "consumer", status: "ok", children: [] }
 *     ] }
 *   ] }
 * ]);
 * ```
 *
 * @param spans - The spans, for example one trace.
 * @returns The root nodes, in start order.
 */
export function spanTree(spans: readonly SpanRecord[]): SpanNode[] {
  const ids = new Set(spans.map(span => span.spanId));
  const ordered = [...spans].sort((left, right) => left.startTime - right.startTime);
  /**
   * Builds the node of one span.
   *
   * @param span - The span whose subtree is built.
   * @returns The span and its descendants.
   */
  const node = (span: SpanRecord): SpanNode => ({
    name: span.name,
    kind: span.kind,
    status: span.status.code === "error" ? "error" : "ok",
    children: ordered.filter(child => child.parentSpanId === span.spanId).map(node)
  });
  return ordered.filter(span => span.parentSpanId === undefined || !ids.has(span.parentSpanId)).map(node);
}