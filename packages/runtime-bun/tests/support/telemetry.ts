import type {
  MetricRecord,
  SpanRecord,
  TelemetryExporter,
  TelemetryLogRecord
} from "@holqa/core";

import type { TelemetryIdGenerator } from "@/telemetry/tracer";

/** An exporter that keeps everything it receives. */
export interface RecordingExporter extends TelemetryExporter {
  readonly spans: SpanRecord[];
  readonly metrics: MetricRecord[][];
  readonly logs: TelemetryLogRecord[];
}

/**
 * Creates an exporter that records every span, metric collection and log record.
 *
 * @param name - How the exporter is identified in problem reports.
 * @returns The exporter and what it received.
 */
export function recordingExporter(name = "memory"): RecordingExporter {
  const spans: SpanRecord[] = [];
  const metrics: MetricRecord[][] = [];
  const logs: TelemetryLogRecord[] = [];
  return {
    name,
    spans,
    metrics,
    logs,
    exportSpans: async (batch) => {
      spans.push(...batch);
    },
    exportMetrics: async (collection) => {
      metrics.push([...collection]);
    },
    exportLogs: async (batch) => {
      logs.push(...batch);
    }
  };
}

/**
 * Creates sequential, valid trace and span identifiers.
 *
 * @returns Identifiers `…0001`, `…0002`, ... padded to the required lengths.
 */
export function sequentialTelemetryIds(): TelemetryIdGenerator {
  let next = 0;
  return {
    traceId: () => (++next).toString(16).padStart(32, "0"),
    spanId: () => (++next).toString(16).padStart(16, "0")
  };
}