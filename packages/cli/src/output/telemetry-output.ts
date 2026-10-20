import type {
  HistogramPoint,
  MetricRecord,
  SpanRecord,
  TelemetryAttributes
} from "@holqa/core";
import type { TraceSummary } from "@holqa/local";

/** The width of the timeline bar in `holqa traces inspect`. */
const timelineWidth = 32;

/**
 * Formats epoch milliseconds as a UTC time with milliseconds.
 *
 * @param ms - Epoch milliseconds.
 * @returns `YYYY-MM-DD HH:MM:SS.mmm`.
 */
function timeOf(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 23);
}

/**
 * Formats a duration in milliseconds for display.
 *
 * @param ms - The duration.
 * @returns For example `0.4 ms`, `12 ms` or `1.25 s`.
 */
function durationOf(ms: number): string {
  if (ms < 1)
    return `${ms.toFixed(1)} ms`;
  if (ms < 1_000)
    return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(2)} s`;
}

/**
 * Formats the table of `holqa traces list`.
 *
 * @param traces - Trace summaries, newest first.
 * @returns The table.
 */
export function formatTraceTable(traces: readonly TraceSummary[]): string {
  const header = `${"TRACE".padEnd(32)}  ${"START (UTC)".padEnd(23)}  ${"DURATION".padStart(9)}  SPANS  ERRORS  NAME`;
  return [header, ...traces.map(trace => `${trace.traceId}  ${timeOf(trace.startTime)}  ${durationOf(trace.durationMs).padStart(9)}  ${String(trace.spans).padStart(5)}  ${String(trace.errors).padStart(6)}  ${trace.name}`)].join("\n");
}

/**
 * Formats one trace as a tree of spans, children under their parents in
 * start order, with each span's offset, a timeline bar, its duration and
 * status, the error type and exception message of failed spans, and links
 * to spans of other traces. Spans whose parent was not recorded locally
 * (for example a remote caller's span) are shown at the top level.
 *
 * @param traceId - The trace.
 * @param spans - Its spans.
 * @returns The text.
 */
export function formatTraceTree(traceId: string, spans: readonly SpanRecord[]): string {
  const start = Math.min(...spans.map(span => span.startTime));
  const end = Math.max(...spans.map(span => span.endTime));
  const total = Math.max(end - start, 0.001);
  const ids = new Set(spans.map(span => span.spanId));
  const children = new Map<string | undefined, SpanRecord[]>();
  for (const span of [...spans].sort((left, right) => left.startTime - right.startTime)) {
    const parent = span.parentSpanId !== undefined && ids.has(span.parentSpanId) ? span.parentSpanId : undefined;
    children.set(parent, [...children.get(parent) ?? [], span]);
  }
  const errors = spans.filter(span => span.status.code === "error").length;
  const lines = [`trace ${traceId}  ${spans.length} span${spans.length === 1 ? "" : "s"}  ${durationOf(end - start)}${errors === 0 ? "" : `  ${errors} error${errors === 1 ? "" : "s"}`}`];
  const rows: Array<{ readonly label: string; readonly rest: string } | string> = [];

  /**
   * Appends one span and its children.
   *
   * @param span - The span.
   * @param prefix - The tree prefix of its children.
   * @param branch - The connector in front of its name.
   */
  const visit = (span: SpanRecord, prefix: string, branch: string): void => {
    const offset = span.startTime - start;
    const duration = span.endTime - span.startTime;
    const from = Math.min(timelineWidth - 1, Math.floor((offset / total) * timelineWidth));
    const width = Math.max(1, Math.round((duration / total) * timelineWidth));
    const bar = `${" ".repeat(from)}${"#".repeat(Math.min(width, timelineWidth - from))}`.padEnd(timelineWidth);
    const status = span.status.code === "error" ? `error${typeof span.attributes["error.type"] === "string" ? ` ${span.attributes["error.type"]}` : ""}` : "ok";
    rows.push({ label: `${branch}${span.name}`, rest: `${span.kind.padEnd(8)}  +${durationOf(offset).padStart(8)}  |${bar}|  ${durationOf(duration).padStart(8)}  ${status}` });
    const detail = `${prefix}${(children.get(span.spanId) ?? []).length > 0 ? "|  " : "   "}`;
    for (const event of span.events.filter(candidate => candidate.name === "exception"))
      rows.push(`${detail}  exception: ${String(event.attributes?.["exception.type"] ?? "Error")}: ${String(event.attributes?.["exception.message"] ?? "")}`);
    for (const link of span.links.filter(candidate => candidate.traceId !== traceId))
      rows.push(`${detail}  linked to trace ${link.traceId} span ${link.spanId}`);
    const kids = children.get(span.spanId) ?? [];
    kids.forEach((child, index) => {
      const last = index === kids.length - 1;
      visit(child, `${prefix}${last ? "   " : "|  "}`, `${prefix}${last ? "`- " : "|- "}`);
    });
  };
  for (const root of children.get(undefined) ?? [])
    visit(root, "", "");
  const width = Math.max(...rows.map(row => typeof row === "string" ? 0 : row.label.length));
  for (const row of rows)
    lines.push(typeof row === "string" ? row : `${row.label.padEnd(width)}  ${row.rest}`);
  return lines.join("\n");
}

/**
 * Formats attributes as `key=value` pairs.
 *
 * @param attributes - A metric point's attributes.
 * @returns The pairs, sorted by key, or `(all)` when there are none.
 */
function labelsOf(attributes: TelemetryAttributes): string {
  const entries = Object.entries(attributes).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return entries.length === 0 ? "(all)" : entries.map(([key, value]) => `${key}=${String(value)}`).join(" ");
}

/**
 * Estimates a quantile from histogram buckets: the upper boundary of the
 * bucket the quantile falls in, so the true value is at most this.
 *
 * @param point - The histogram point.
 * @param quantile - From 0 to 1.
 * @returns The bound, or the maximum when the quantile falls in the last bucket.
 */
function quantileBound(point: HistogramPoint, quantile: number): number {
  const target = point.count * quantile;
  let seen = 0;
  for (const [index, count] of point.bucketCounts.entries()) {
    seen += count;
    if (seen >= target && count > 0)
      return Math.min(point.bounds[index] ?? point.max, point.max);
  }
  return point.max;
}

/**
 * Formats a number compactly.
 *
 * @param value - The number.
 * @param unit - Its unit; seconds are shown in milliseconds.
 * @returns The text.
 */
function valueOf(value: number, unit: string): string {
  if (unit === "s")
    return durationOf(value * 1_000);
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/**
 * Formats the output of `holqa metrics`: every metric with its series. Counters
 * and gauges show their value; histograms their count, average, estimated
 * p50 and p95 (upper bucket bounds) and maximum.
 *
 * @param metrics - The metrics, sorted by name.
 * @returns The text.
 */
export function summarizeMetrics(metrics: readonly MetricRecord[]): string {
  const lines: string[] = [];
  for (const metric of metrics) {
    lines.push(`${metric.name} (${metric.type === "sum" ? "counter" : metric.type}, ${metric.unit})`);
    for (const point of metric.points) {
      if ("count" in point) {
        const average = point.count === 0 ? 0 : point.sum / point.count;
        lines.push(`  ${labelsOf(point.attributes)}  count ${point.count}  avg ${valueOf(average, metric.unit)}  p50 <= ${valueOf(quantileBound(point, 0.5), metric.unit)}  p95 <= ${valueOf(quantileBound(point, 0.95), metric.unit)}  max ${valueOf(point.max, metric.unit)}`);
      } else {
        lines.push(`  ${labelsOf(point.attributes)}  ${valueOf(point.value, metric.unit)}`);
      }
    }
  }
  return lines.join("\n");
}