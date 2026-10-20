import type {
  MetricRecord,
  SpanRecord,
  TelemetryExporter,
  TelemetryLogRecord,
  TelemetryResource
} from "@holqa/core";

/** A telemetry signal the pipeline buffers. */
export type BufferedSignal = "spans" | "logs";

/** Why records were dropped. */
export type DropReason = "buffer-full" | "export-failed";

/** One export problem, reported to the runtime's log. */
export interface ExportProblem {
  readonly exporter: string;
  /** The signal that failed, or `shutdown` when shutting the exporter down failed. */
  readonly signal: BufferedSignal | "metrics" | "shutdown";
  readonly message: string;
  /** Failures of this exporter and signal since the last report, this one included. */
  readonly failures: number;
}

/** Limits of the export pipeline. */
export interface PipelineLimits {
  /** The most spans and, separately, log records waiting for export; more are dropped. */
  readonly maxQueueSize: number;
  /** The most records in one export call. */
  readonly maxBatchSize: number;
  /** How often buffered spans and logs are exported, in milliseconds. */
  readonly flushIntervalMs: number;
  /** How often metrics are collected and exported, in milliseconds. */
  readonly metricIntervalMs: number;
  /** How long one export call may take before its batch counts as failed, in milliseconds. */
  readonly exportTimeoutMs: number;
}

/** Settings of a {@link TelemetryPipeline}. */
export interface PipelineOptions {
  readonly exporters: readonly TelemetryExporter[];
  readonly resource: TelemetryResource;
  readonly limits: PipelineLimits;
  /** Collects the current metrics. */
  readonly collectMetrics: () => Promise<MetricRecord[]>;
  /** Counts dropped records, for the `holqa.telemetry.dropped` metric. */
  readonly onDrop: (signal: BufferedSignal, reason: DropReason, count: number) => void;
  /** Reports an export problem; called at most once per minute per exporter and signal. */
  readonly report: (problem: ExportProblem) => void;
  /** The monotonic clock, in milliseconds, for rate-limiting reports. */
  readonly monotonicNow: () => number;
}

/** Counters of a pipeline. */
export interface TelemetryStats {
  /** Spans handed to the pipeline (sampled spans only). */
  readonly spansRecorded: number;
  /** Spans dropped because the buffer was full or every exporter failed. */
  readonly spansDropped: number;
  readonly logsRecorded: number;
  readonly logsDropped: number;
  /** Export calls that rejected or timed out, across exporters and signals. */
  readonly exportFailures: number;
  /** Records waiting for export. */
  readonly pending: number;
}

/** How long reports about a failing exporter are suppressed after one is written. */
const reportIntervalMs = 60_000;

/**
 * Buffers telemetry and exports it in the background. Recording never waits
 * for an exporter: buffers are bounded (a full buffer drops the newest
 * records and counts them), exports run one batch at a time per signal,
 * every export call has a time limit, and an exporter that rejects or times
 * out loses that batch for itself only. Problems are reported, rate-limited,
 * instead of thrown. Timers are unreferenced, so telemetry never keeps a
 * process alive.
 */
export class TelemetryPipeline {
  /** Settings. */
  private readonly options: PipelineOptions;
  /** Buffered spans. */
  private spans: SpanRecord[] = [];
  /** Buffered log records. */
  private logs: TelemetryLogRecord[] = [];
  /** A scheduled export of a full batch, so recording never runs exporter code. */
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  /** Exports in progress, by signal. */
  private readonly inFlight = new Map<BufferedSignal | "metrics", Promise<void>>();
  /** Background timers. */
  private timers: Array<ReturnType<typeof setInterval>> = [];
  /** Report suppression by exporter and signal: when the last report was written and how many failures followed. */
  private readonly reports = new Map<string, { at: number; failures: number }>();
  /** Whether the pipeline was shut down. */
  private closed = false;
  /** Counters. */
  private counts = { spansRecorded: 0, spansDropped: 0, logsRecorded: 0, logsDropped: 0, exportFailures: 0 };

  /**
   * Creates a pipeline; nothing is exported until {@link start} or {@link flush}.
   *
   * @param options - Exporters, resource, limits and callbacks.
   */
  constructor(options: PipelineOptions) {
    this.options = options;
  }

  /** Starts the background export timers. Calling it again has no effect. */
  start(): void {
    if (this.timers.length > 0 || this.closed)
      return;
    const { flushIntervalMs, metricIntervalMs } = this.options.limits;
    const spans = setInterval(() => void this.exportBuffered("spans"), flushIntervalMs);
    const logs = setInterval(() => void this.exportBuffered("logs"), flushIntervalMs);
    const metrics = setInterval(() => void this.exportMetrics(), metricIntervalMs);
    for (const timer of [spans, logs, metrics])
      (timer as { unref?: () => void }).unref?.();
    this.timers = [spans, logs, metrics];
  }

  /**
   * Buffers a finished span.
   *
   * @param span - A finished, sampled span.
   */
  addSpan(span: SpanRecord): void {
    this.counts.spansRecorded += 1;
    if (this.closed || !this.options.exporters.some(exporter => exporter.exportSpans !== undefined))
      return;
    if (this.spans.length >= this.options.limits.maxQueueSize) {
      this.counts.spansDropped += 1;
      this.options.onDrop("spans", "buffer-full", 1);
      return;
    }
    this.spans.push(span);
    if (this.spans.length >= this.options.limits.maxBatchSize)
      this.schedule();
  }

  /**
   * Buffers a log record.
   *
   * @param record - An already redacted log record.
   */
  addLog(record: TelemetryLogRecord): void {
    this.counts.logsRecorded += 1;
    if (this.closed || !this.options.exporters.some(exporter => exporter.exportLogs !== undefined))
      return;
    if (this.logs.length >= this.options.limits.maxQueueSize) {
      this.counts.logsDropped += 1;
      this.options.onDrop("logs", "buffer-full", 1);
      return;
    }
    this.logs.push(record);
    if (this.logs.length >= this.options.limits.maxBatchSize)
      this.schedule();
  }

  /**
   * Exports full batches on a later turn of the event loop, so that the
   * invocation that recorded the last record never runs exporter code.
   */
  private schedule(): void {
    if (this.scheduled !== undefined)
      return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.exportBuffered("spans");
      void this.exportBuffered("logs");
    }, 0);
    (this.scheduled as { unref?: () => void }).unref?.();
  }

  /**
   * Exports everything buffered and one collection of metrics, and waits for
   * the exports to finish or time out. Never rejects.
   *
   * @returns A promise that settles once the exports have finished.
   */
  async flush(): Promise<void> {
    await Promise.all([this.drain("spans"), this.drain("logs"), this.exportMetrics()]);
  }

  /**
   * Flushes, stops the timers and shuts down every exporter, within a time
   * limit. Records arriving afterwards are ignored. Never rejects.
   *
   * @param timeoutMs - The longest time to wait in total.
   * @returns A promise that settles once the pipeline is closed or the time ran out.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    for (const timer of this.timers)
      clearInterval(timer);
    this.timers = [];
    clearTimeout(this.scheduled);
    this.scheduled = undefined;
    if (this.closed)
      return;
    const work = (async () => {
      await this.flush();
      this.closed = true;
      await Promise.all(this.options.exporters.map(async (exporter) => {
        try {
          await exporter.shutdown?.();
        } catch (error) {
          this.problem(exporter.name, "shutdown", `shutting down failed: ${messageOf(error)}`);
        }
      }));
    })();
    try {
      await withTimeout(() => work, timeoutMs);
    } catch (error) {
      this.problem("pipeline", "shutdown", `the final export did not finish: ${messageOf(error)}`);
    }
    this.closed = true;
  }

  /**
   * Returns the pipeline's counters.
   *
   * @returns A snapshot.
   */
  stats(): TelemetryStats {
    return Object.freeze({ ...this.counts, pending: this.spans.length + this.logs.length });
  }

  /**
   * Exports buffered records of one signal until the buffer is empty.
   *
   * @param signal - Which buffer.
   * @returns A promise that settles once the buffer was empty at the end of an export.
   */
  private async drain(signal: BufferedSignal): Promise<void> {
    for (let rounds = 0; rounds < 1_000; rounds += 1) {
      await this.exportBuffered(signal);
      if ((signal === "spans" ? this.spans : this.logs).length === 0 && !this.inFlight.has(signal))
        return;
    }
  }

  /**
   * Exports up to one batch of a signal, unless an export of it is already running.
   *
   * @param signal - Which buffer.
   * @returns A promise that settles once the running or started export has finished.
   */
  private exportBuffered(signal: BufferedSignal): Promise<void> {
    const running = this.inFlight.get(signal);
    if (running !== undefined)
      return running;
    const buffer = signal === "spans" ? this.spans : this.logs;
    if (buffer.length === 0)
      return Promise.resolve();
    const batch = buffer.splice(0, this.options.limits.maxBatchSize);
    const work = this.send(signal, batch).finally(() => this.inFlight.delete(signal));
    this.inFlight.set(signal, work);
    return work;
  }

  /**
   * Sends one batch to every exporter of its signal, independently.
   *
   * @param signal - The batch's signal.
   * @param batch - The records.
   * @returns A promise that settles once every exporter has finished or timed out.
   */
  private async send(signal: BufferedSignal, batch: readonly SpanRecord[] | readonly TelemetryLogRecord[]): Promise<void> {
    const { resource, exporters, limits } = this.options;
    const targets = exporters.filter(exporter => (signal === "spans" ? exporter.exportSpans : exporter.exportLogs) !== undefined);
    const results = await Promise.all(targets.map(async (exporter) => {
      try {
        await withTimeout(options => signal === "spans" ? exporter.exportSpans!(batch as readonly SpanRecord[], resource, options) : exporter.exportLogs!(batch as readonly TelemetryLogRecord[], resource, options), limits.exportTimeoutMs);
        return true;
      } catch (error) {
        this.problem(exporter.name, signal, messageOf(error));
        return false;
      }
    }));
    // Records are lost only when no exporter received them.
    if (results.length > 0 && results.every(result => !result)) {
      if (signal === "spans")
        this.counts.spansDropped += batch.length;
      else
        this.counts.logsDropped += batch.length;
      this.options.onDrop(signal, "export-failed", batch.length);
    }
  }

  /**
   * Collects metrics and sends them to every exporter that takes metrics.
   *
   * @returns A promise that settles once every exporter has finished or timed out.
   */
  private exportMetrics(): Promise<void> {
    const running = this.inFlight.get("metrics");
    if (running !== undefined)
      return running;
    const targets = this.options.exporters.filter(exporter => exporter.exportMetrics !== undefined);
    if (targets.length === 0 || this.closed)
      return Promise.resolve();
    const work = (async () => {
      let metrics: MetricRecord[];
      try {
        metrics = await this.options.collectMetrics();
      } catch (error) {
        this.problem("meter", "metrics", `collecting metrics failed: ${messageOf(error)}`);
        return;
      }
      if (metrics.length === 0)
        return;
      await Promise.all(targets.map(async (exporter) => {
        try {
          await withTimeout(options => exporter.exportMetrics!(metrics, this.options.resource, options), this.options.limits.exportTimeoutMs);
        } catch (error) {
          this.problem(exporter.name, "metrics", messageOf(error));
        }
      }));
    })().finally(() => this.inFlight.delete("metrics"));
    this.inFlight.set("metrics", work);
    return work;
  }

  /**
   * Counts a failed export and reports it unless a report for the same
   * exporter and signal was written within the last minute.
   *
   * @param exporter - The exporter's name.
   * @param signal - The signal that failed.
   * @param message - What went wrong.
   */
  private problem(exporter: string, signal: ExportProblem["signal"], message: string): void {
    this.counts.exportFailures += 1;
    const key = `${exporter}\u0000${signal}`;
    const now = this.options.monotonicNow();
    const last = this.reports.get(key);
    if (last !== undefined && now - last.at < reportIntervalMs) {
      last.failures += 1;
      return;
    }
    this.reports.set(key, { at: now, failures: 0 });
    this.options.report({ exporter, signal, message, failures: (last?.failures ?? 0) + 1 });
  }
}

/**
 * Runs work with a time limit: when it passes, the work's signal is aborted
 * and the call rejects, whether or not the work stops. The timer never keeps
 * the process alive.
 *
 * @param work - Starts the work; receives the signal to stop it.
 * @param timeoutMs - The time limit in milliseconds.
 * @returns The work's result.
 * @throws {Error} When the work fails or the time limit passes first.
 */
async function withTimeout<Result>(work: (options: { readonly signal: AbortSignal }) => Promise<Result>, timeoutMs: number): Promise<Result> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${timeoutMs} ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    // Started inside the race, so a work function that throws synchronously becomes a rejection.
    return await Promise.race([Promise.resolve().then(() => work({ signal: controller.signal })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Describes a caught value in one line.
 *
 * @param error - The caught value.
 * @returns Its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}