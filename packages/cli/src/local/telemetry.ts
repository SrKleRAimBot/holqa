import type { LocalTelemetryStore } from "@holqa/local";
import type {
  LogEntry,
  RuntimeTelemetryOptions
} from "@holqa/runtime-bun";

import { HolqaError } from "@holqa/core";
import { createLocalTelemetryStore } from "@holqa/local";
import {
  createOtlpHttpExporter,
  readOtelEnvironment
} from "@holqa/opentelemetry";

/** The telemetry of one application process the CLI starts. */
export interface ProcessTelemetry {
  /** The local telemetry store that `holqa logs`, `traces`, `events inspect` and `metrics` read. */
  readonly store: LocalTelemetryStore;
  /** The runtime's telemetry settings: the local store, and an OTLP exporter when the environment configures one. */
  readonly options: RuntimeTelemetryOptions;
  /** Stores a runtime log entry. */
  readonly writeLog: (entry: LogEntry) => void;
}

/**
 * Opens the telemetry of an application process: spans, metrics and logs go
 * to the local telemetry store in the state directory, and also to an
 * OTLP/HTTP receiver when the standard `OTEL_EXPORTER_OTLP_*` variables
 * configure one. Both are optional for the application: a failing exporter
 * only loses its own data.
 *
 * @param stateDir - The local state directory.
 * @param env - The process environment, read for `OTEL_*` variables.
 * @returns The store and the runtime settings.
 * @throws {HolqaError} `HOLQA_TELEMETRY_CONFIG_INVALID` when the `OTEL_*` variables ask for something unsupported.
 */
export function openProcessTelemetry(stateDir: string, env: Readonly<Record<string, string | undefined>>): ProcessTelemetry {
  const settings = readOtelEnvironment(env);
  if (!settings.ok)
    throw new HolqaError(settings.error);
  const { exporter, serviceName, resource, sampleRatio, exportLogs } = settings.value;
  const store = createLocalTelemetryStore({ directory: stateDir });
  return {
    store,
    writeLog: entry => store.writeLog(entry),
    options: {
      exporters: exporter === undefined ? [store.exporter] : [store.exporter, createOtlpHttpExporter(exporter)],
      // Development runs are short: export metrics often enough for `holqa metrics` to be current.
      limits: { metricIntervalMs: 2_000 },
      ...serviceName === undefined ? {} : { serviceName },
      ...resource === undefined ? {} : { resource },
      ...sampleRatio === undefined ? {} : { sampleRatio },
      ...exportLogs === undefined ? {} : { exportLogs }
    }
  };
}