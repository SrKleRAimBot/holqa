import type {
  Diagnostic,
  FrameworkMetric,
  Redactor,
  TelemetryAttributes,
  TelemetryExporter,
  TelemetryLogRecord
} from "@holqa/core";

import type { GaugeObservation } from "@/telemetry/meter";
import type {
  ExportProblem,
  PipelineLimits,
  TelemetryStats
} from "@/telemetry/pipeline";
import type {
  ActiveSpan,
  SpanStart,
  TelemetryIdGenerator
} from "@/telemetry/tracer";

import {
  createDiagnostic,
  diagnosticCodes,
  frameworkMetrics,
  isSpanId,
  isTraceId,
  randomSpanId,
  randomTraceId
} from "@holqa/core";

import { Meter } from "@/telemetry/meter";
import { TelemetryPipeline } from "@/telemetry/pipeline";
import { Tracer } from "@/telemetry/tracer";

/**
 * How a message or object event's processing span relates to the span that
 * published it. `parent` makes it a child, so one request and everything it
 * caused form one trace; `link` starts a new trace per delivery with a span
 * link back to the publisher, as OpenTelemetry's messaging conventions
 * recommend when deliveries are batched or long-delayed. Both record a link.
 */
export type MessageTraceRelation = "parent" | "link";

/** Telemetry settings of a runtime. */
export interface RuntimeTelemetryOptions {
  /**
   * Whether the runtime records spans and metrics. Default: `true` when
   * `exporters` is not empty. Enabled without exporters, logs still carry
   * `traceId` and `spanId` and trace context is still propagated.
   */
  readonly enabled?: boolean;
  /** Where telemetry goes, for example an OTLP exporter or a local store. Default none. */
  readonly exporters?: readonly TelemetryExporter[];
  /** The `service.name` resource attribute. Default: the application's name. */
  readonly serviceName?: string;
  /** Additional resource attributes, for example `{ "deployment.environment.name": "staging" }`. */
  readonly resource?: TelemetryAttributes;
  /** The share of new traces that are recorded, from 0 to 1. Traces continued from a caller follow the caller's decision. Default 1. Lineage and safety limits never depend on it. */
  readonly sampleRatio?: number;
  /** How processing spans relate to the span that published the message or object. Default `parent`. */
  readonly messages?: MessageTraceRelation;
  /**
   * Whether HTTP requests continue a caller's `traceparent`, including its
   * sampling decision (parent-based sampling). Default `true`, as in
   * OpenTelemetry. A caller can then force its requests to be sampled; the
   * export buffers stay bounded, but set `false` for untrusted callers so
   * every request starts a new trace sampled by `sampleRatio`.
   */
  readonly acceptTraceparent?: boolean;
  /** Whether log entries are also sent to exporters as OpenTelemetry log records. Default `false`: the OpenTelemetry logs signal is still under development in JavaScript. */
  readonly exportLogs?: boolean;
  /** Buffer, batch, interval and cardinality limits. */
  readonly limits?: Partial<PipelineLimits> & {
    /** The most attribute combinations one metric tracks. Default 2 000. */
    readonly maxSeriesPerMetric?: number;
  };
  /** Creates trace and span identifiers. Default: random, from the Web Crypto API. */
  readonly ids?: TelemetryIdGenerator;
}

/** Default pipeline limits. */
const defaultLimits: PipelineLimits = Object.freeze({ maxQueueSize: 2_048, maxBatchSize: 512, flushIntervalMs: 1_000, metricIntervalMs: 10_000, exportTimeoutMs: 10_000 });

/** What {@link RuntimeTelemetry} needs from its runtime. */
export interface RuntimeTelemetryContext {
  /** The application's name, the default service name. */
  readonly appName: string;
  readonly wallNow: () => number;
  readonly monotonicNow: () => number;
  readonly redactor: Redactor;
  /** Receives export problems, for the runtime's log. */
  readonly report: (problem: ExportProblem) => void;
}

/**
 * Validates telemetry settings.
 *
 * @param options - The settings, unvalidated.
 * @returns One `HOLQA_TELEMETRY_CONFIG_INVALID` diagnostic per problem.
 */
export function telemetryOptionProblems(options: RuntimeTelemetryOptions | undefined): Diagnostic[] {
  if (options === undefined)
    return [];
  const problems: string[] = [];
  const known = new Set(["enabled", "exporters", "serviceName", "resource", "sampleRatio", "messages", "acceptTraceparent", "exportLogs", "limits", "ids"]);
  for (const name of Object.keys(options)) {
    if (!known.has(name))
      problems.push(`"telemetry.${name}" is not a telemetry setting.`);
  }
  if (options.enabled !== undefined && typeof options.enabled !== "boolean")
    problems.push("\"telemetry.enabled\" must be a boolean.");
  if (options.exporters !== undefined && (!Array.isArray(options.exporters) || options.exporters.some(exporter => typeof exporter !== "object" || exporter === null || typeof exporter.name !== "string")))
    problems.push("\"telemetry.exporters\" must be a list of exporters, each with a name.");
  if (options.sampleRatio !== undefined && !(typeof options.sampleRatio === "number" && options.sampleRatio >= 0 && options.sampleRatio <= 1))
    problems.push("\"telemetry.sampleRatio\" must be a number from 0 to 1.");
  if (options.messages !== undefined && options.messages !== "parent" && options.messages !== "link")
    problems.push("\"telemetry.messages\" must be \"parent\" or \"link\".");
  for (const name of ["acceptTraceparent", "exportLogs"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "boolean")
      problems.push(`"telemetry.${name}" must be a boolean.`);
  }
  if (options.ids !== undefined && (typeof options.ids !== "object" || options.ids === null || typeof options.ids.traceId !== "function" || typeof options.ids.spanId !== "function"))
    problems.push("\"telemetry.ids\" must provide traceId and spanId functions.");
  if (options.resource !== undefined && (typeof options.resource !== "object" || options.resource === null || Array.isArray(options.resource)))
    problems.push("\"telemetry.resource\" must be an object of attributes.");
  if (options.serviceName !== undefined && (typeof options.serviceName !== "string" || options.serviceName === ""))
    problems.push("\"telemetry.serviceName\" must be a non-empty string.");
  for (const [name, value] of Object.entries(options.limits ?? {})) {
    if (!(name in defaultLimits) && name !== "maxSeriesPerMetric")
      problems.push(`"telemetry.limits.${name}" is not a telemetry limit.`);
    else if (!(typeof value === "number" && Number.isSafeInteger(value) && value >= 1))
      problems.push(`"telemetry.limits.${name}" must be an integer of at least 1.`);
  }
  return problems.map(message => createDiagnostic({ code: diagnosticCodes.telemetryConfigInvalid, severity: "error", message }));
}

/**
 * The telemetry of one runtime: a tracer, a meter with the framework
 * metrics, and the background export pipeline. When telemetry is disabled,
 * {@link startSpan} returns `undefined` and measurements are discarded, so
 * instrumented code only pays for a branch.
 */
export class RuntimeTelemetry {
  /** Whether spans and metrics are recorded. */
  readonly enabled: boolean;
  /** How processing spans relate to their publisher. */
  readonly messages: MessageTraceRelation;
  /** Whether incoming HTTP `traceparent` headers are continued. */
  readonly acceptTraceparent: boolean;
  /** Starts spans. */
  private readonly tracer: Tracer | undefined;
  /** Aggregates metrics. */
  private readonly meter: Meter | undefined;
  /** Exports telemetry. */
  private readonly pipeline: TelemetryPipeline | undefined;
  /** Whether log records are exported. */
  private readonly exportLogs: boolean;

  /**
   * Creates the runtime's telemetry; call {@link start} once the runtime runs.
   *
   * @param options - Validated settings (see {@link telemetryOptionProblems}).
   * @param context - The application name, clocks, redactor and problem reporter.
   */
  constructor(options: RuntimeTelemetryOptions | undefined, context: RuntimeTelemetryContext) {
    const exporters = options?.exporters ?? [];
    this.enabled = options?.enabled ?? exporters.length > 0;
    this.messages = options?.messages ?? "parent";
    this.acceptTraceparent = options?.acceptTraceparent ?? true;
    this.exportLogs = this.enabled && options?.exportLogs === true;
    if (!this.enabled)
      return;
    const custom = options?.ids;
    // Identifiers from a custom generator are checked, so a broken generator cannot emit invalid trace context.
    const ids = custom === undefined
      ? { traceId: randomTraceId, spanId: randomSpanId }
      : { traceId: () => checkedId(custom.traceId(), isTraceId, randomTraceId), spanId: () => checkedId(custom.spanId(), isSpanId, randomSpanId) };
    const limits: PipelineLimits = { ...defaultLimits, ...options?.limits };
    this.meter = new Meter({ maxSeries: options?.limits?.maxSeriesPerMetric ?? 2_000, wallNow: context.wallNow, onGaugeError: (metric, error) => context.report({ exporter: "meter", signal: "metrics", message: `the gauge ${metric} could not be observed: ${error instanceof Error ? error.message : String(error)}`, failures: 1 }) });
    const meter = this.meter;
    const pipeline = new TelemetryPipeline({
      exporters,
      resource: Object.freeze({ attributes: Object.freeze({ "service.name": options?.serviceName ?? context.appName, "service.instance.id": crypto.randomUUID(), "telemetry.sdk.name": "holqa", "telemetry.sdk.language": "nodejs", ...options?.resource }) }),
      limits,
      collectMetrics: () => meter.collect(),
      onDrop: (signal, reason, count) => meter.add(frameworkMetrics.telemetryDropped, count, { "holqa.telemetry.signal": signal, "holqa.telemetry.reason": reason }),
      report: context.report,
      monotonicNow: context.monotonicNow
    });
    this.pipeline = pipeline;
    this.tracer = new Tracer({ sampleRatio: options?.sampleRatio ?? 1, ids, wallNow: context.wallNow, monotonicNow: context.monotonicNow, redactor: context.redactor, onEnd: span => pipeline.addSpan(span) });
  }

  /** Starts background exports. */
  start(): void {
    this.pipeline?.start();
  }

  /**
   * Starts a span.
   *
   * @param start - Its name, kind, parent, links and attributes.
   * @returns The span, or `undefined` when telemetry is disabled.
   */
  startSpan(start: SpanStart): ActiveSpan | undefined {
    return this.tracer?.startSpan(start);
  }

  /**
   * Adds to a framework counter.
   *
   * @param metric - The counter.
   * @param value - The amount.
   * @param attributes - The measurement's attributes; only the metric's allowed keys are kept.
   */
  count(metric: FrameworkMetric, value: number, attributes?: TelemetryAttributes): void {
    this.meter?.add(metric, value, attributes);
  }

  /**
   * Records a value in a framework histogram.
   *
   * @param metric - The histogram.
   * @param value - The measurement, for example a duration in seconds.
   * @param attributes - The measurement's attributes; only the metric's allowed keys are kept.
   */
  record(metric: FrameworkMetric, value: number, attributes?: TelemetryAttributes): void {
    this.meter?.record(metric, value, attributes);
  }

  /**
   * Registers a framework gauge.
   *
   * @param metric - The gauge's definition.
   * @param observe - Returns its current values.
   */
  gauge(metric: FrameworkMetric, observe: () => Promise<readonly GaugeObservation[]> | readonly GaugeObservation[]): void {
    this.meter?.gauge(metric, observe);
  }

  /**
   * Hands a log record to the exporters, when log export is enabled.
   *
   * @param record - The already redacted record.
   */
  log(record: TelemetryLogRecord): void {
    if (this.exportLogs)
      this.pipeline?.addLog(record);
  }

  /**
   * Exports everything recorded so far and waits for it. Never rejects.
   *
   * @returns A promise that settles once the exports have finished.
   */
  async flush(): Promise<void> {
    await this.pipeline?.flush();
  }

  /**
   * Flushes and shuts the exporters down within a time limit. Never rejects.
   *
   * @param timeoutMs - The longest time to wait.
   * @returns A promise that settles once telemetry is closed.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    await this.pipeline?.shutdown(timeoutMs);
  }

  /**
   * Returns the export counters.
   *
   * @returns A snapshot; all zero when telemetry is disabled.
   */
  stats(): TelemetryStats {
    return this.pipeline?.stats() ?? Object.freeze({ spansRecorded: 0, spansDropped: 0, logsRecorded: 0, logsDropped: 0, exportFailures: 0, pending: 0 });
  }
}

/**
 * Uses a generated identifier when it is valid, and a random one otherwise.
 *
 * @param candidate - What the custom generator returned.
 * @param valid - Checks the identifier's format.
 * @param fallback - Creates a valid random identifier.
 * @returns A valid identifier.
 */
function checkedId(candidate: unknown, valid: (value: unknown) => value is string, fallback: () => string): string {
  return valid(candidate) ? candidate : fallback();
}