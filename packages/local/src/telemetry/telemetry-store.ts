import type {
  FrameworkMetric,
  MetricRecord,
  SpanRecord,
  TelemetryAttributes,
  TelemetryExporter,
  TelemetryResource
} from "@holqa/core";
import type {
  LogEntry,
  LogLevel
} from "@holqa/runtime-bun";

import type { Clock } from "@/clock";
import {
  existsSync,
  mkdirSync
} from "node:fs";
import { join } from "node:path";

import {
  diagnosticCodes,
  failWith,
  isSpanId,
  isTraceId
} from "@holqa/core";

import { Database } from "bun:sqlite";

import { systemClock } from "@/clock";

/** The file the telemetry store lives in, inside the local state directory. */
export const telemetryFileName = "telemetry.sqlite";

/** The format of the telemetry store this version reads and writes. */
export const telemetryStoreVersion = 1;

/**
 * The tables of the telemetry store. Times are epoch milliseconds. Spans and
 * logs keep the fields commands filter on in columns, and the complete
 * record as JSON. Metrics keep the latest cumulative point of every series,
 * per runtime instance.
 */
const schema = `
CREATE TABLE IF NOT EXISTS spans (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  status TEXT NOT NULL,
  service TEXT NOT NULL,
  invocation_id TEXT,
  delivery_id TEXT,
  record TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS spans_trace ON spans (trace_id);
CREATE INDEX IF NOT EXISTS spans_delivery ON spans (delivery_id);
CREATE INDEX IF NOT EXISTS spans_invocation ON spans (invocation_id);
CREATE TABLE IF NOT EXISTS logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  time REAL NOT NULL,
  level TEXT NOT NULL,
  handler_id TEXT,
  invocation_id TEXT,
  correlation_id TEXT,
  trace_id TEXT,
  delivery_id TEXT,
  entry TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS logs_trace ON logs (trace_id);
CREATE INDEX IF NOT EXISTS logs_delivery ON logs (delivery_id);
CREATE TABLE IF NOT EXISTS metrics (
  instance TEXT NOT NULL,
  service TEXT NOT NULL,
  name TEXT NOT NULL,
  series TEXT NOT NULL,
  updated_at REAL NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (instance, name, series)
) STRICT;
`;

/** How much telemetry the store keeps. */
export interface TelemetryRetention {
  /** The most spans kept; older ones are deleted first. Default 20 000. */
  readonly maxSpans?: number;
  /** The most log entries kept; older ones are deleted first. Default 20 000. */
  readonly maxLogs?: number;
  /** Spans, logs and metric series older than this are deleted, in milliseconds. Default 24 hours. */
  readonly maxAgeMs?: number;
}

/** Settings of {@link createLocalTelemetryStore}. */
export interface LocalTelemetryStoreOptions {
  /** The local state directory; the store is `telemetry.sqlite` inside it. Created when missing. `undefined` keeps telemetry in memory. */
  readonly directory: string | undefined;
  readonly retention?: TelemetryRetention;
  /** The time source for retention. Defaults to the wall clock. */
  readonly clock?: Clock;
}

/** One stored log entry and its position, for following new entries. */
export interface StoredLogEntry {
  /** Increases with every entry; pass the last one seen as `after` to read only newer entries. */
  readonly seq: number;
  readonly entry: LogEntry;
}

/** Which log entries {@link LocalTelemetryReader.logs} returns. */
export interface LogQuery {
  /** Only entries written after this position. Without it, the newest `limit` entries. */
  readonly after?: number;
  /** The most entries. Default 100. */
  readonly limit?: number;
  /** Only entries at this level or more severe. */
  readonly level?: LogLevel;
  readonly handlerId?: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  /** Only entries about one queue message or object event. */
  readonly deliveryId?: string;
}

/** A trace as `holqa traces list` shows it. */
export interface TraceSummary {
  readonly traceId: string;
  /** The root span's name, or the earliest span's when the root was not recorded locally. */
  readonly name: string;
  /** Epoch milliseconds of the earliest span. */
  readonly startTime: number;
  /** From the earliest start to the latest end, in milliseconds. */
  readonly durationMs: number;
  readonly spans: number;
  /** Spans with an error status. */
  readonly errors: number;
}

/** Read access to the telemetry of a local state directory. */
export interface LocalTelemetryReader {
  /** Log entries, oldest first. */
  readonly logs: (query?: LogQuery) => StoredLogEntry[];
  /** The most recent traces, newest first. */
  readonly traces: (limit?: number) => TraceSummary[];
  /** Every stored span of one trace, by start time. Empty when the trace is unknown. */
  readonly trace: (traceId: string) => SpanRecord[];
  /** The stored trace identifiers that start with a prefix, at most two, so callers can accept unambiguous short identifiers. */
  readonly matchTraceIds: (prefix: string) => string[];
  /** The spans that processed or published one queue message or object event, by start time. */
  readonly spansOfDelivery: (deliveryId: string) => SpanRecord[];
  /** Cumulative framework metrics, added up across the runtime instances that reported them recently. Gauges come from the latest report. */
  readonly metrics: () => MetricRecord[];
  /** Releases the database; a store writes its queued log entries first. */
  readonly close: () => void;
}

/** The writable telemetry store of a local environment, also usable as a runtime exporter. */
export interface LocalTelemetryStore extends LocalTelemetryReader {
  /** Pass it to `createRuntime({ telemetry: { exporters: [store.exporter] } })`. It stores spans and metrics. */
  readonly exporter: TelemetryExporter;
  /**
   * Queues one runtime log entry for storage; use it from a log sink.
   * Entries are written in batches on a timer, never on the caller's stack,
   * at most 2 048 are queued (more are dropped and counted), and `close`
   * writes what is queued. Entries are already redacted by the runtime.
   */
  readonly writeLog: (entry: LogEntry) => void;
  /** Writes queued log entries now. */
  readonly flushLogs: () => void;
  /** Adds to a counter that a process outside a runtime reports, for example the development supervisor's reload failures. */
  readonly increment: (metric: FrameworkMetric, attributes?: TelemetryAttributes, by?: number) => void;
}

/** Severity order, for level filtering. */
const severity: Readonly<Record<string, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** How many writes happen between retention passes. */
const pruneEvery = 200;

/** The most log entries waiting to be written. */
const maxQueuedLogs = 2_048;

/** How long log entries wait before they are written, in milliseconds. */
const logFlushMs = 200;

/**
 * Opens the telemetry database, creating it and its tables.
 *
 * @param directory - The local state directory, or `undefined` for memory.
 * @returns The open database in write-ahead logging mode.
 * @throws {HolqaError} `HOLQA_LOCAL_STATE_UNSUPPORTED` when a newer version wrote the store.
 */
function openTelemetryDatabase(directory: string | undefined): Database {
  if (directory !== undefined)
    mkdirSync(directory, { recursive: true });
  const database = directory === undefined ? new Database(":memory:", { strict: true }) : new Database(join(directory, telemetryFileName), { create: true, strict: true });
  try {
    database.run("PRAGMA journal_mode = WAL");
    // Several processes write; a short wait keeps a locked store from stalling them. A batch that cannot get the lock fails and is dropped.
    database.run("PRAGMA busy_timeout = 100");
    const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version > telemetryStoreVersion)
      failWith(diagnosticCodes.localStateUnsupported, `The telemetry store in "${directory}" has format ${version}; this version of @holqa/local reads format ${telemetryStoreVersion}.`, `Delete "${join(directory ?? ".", telemetryFileName)}"; it only holds development telemetry.`);
    database.transaction(() => {
      database.run(schema);
      database.run(`PRAGMA user_version = ${telemetryStoreVersion}`);
    })();
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

/**
 * Creates the telemetry store of a local state directory: a bounded SQLite
 * file (`telemetry.sqlite`) that keeps recent spans, log entries and metric
 * series for `holqa logs`, `holqa traces`, `holqa events inspect` and
 * `holqa metrics`. It is a development aid, not an observability backend:
 * retention is short and bounded, and several processes may write to it.
 *
 * @example
 * ```ts
 * const store = createLocalTelemetryStore({ directory: ".holqa/local" });
 * const runtime = createRuntime({ app, handlers, binding: env.binding, log: store.writeLog, telemetry: { exporters: [store.exporter] } });
 * ```
 *
 * @param options - The directory, retention and clock.
 * @returns The store, its exporter and its reader.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` for invalid retention settings, or `HOLQA_LOCAL_STATE_UNSUPPORTED`.
 */
export function createLocalTelemetryStore(options: LocalTelemetryStoreOptions): LocalTelemetryStore {
  const retention = { maxSpans: 20_000, maxLogs: 20_000, maxAgeMs: 86_400_000, ...options.retention };
  for (const [name, value] of Object.entries(retention)) {
    if (!(typeof value === "number" && Number.isSafeInteger(value) && value >= 1))
      failWith(diagnosticCodes.declarationInvalid, `The telemetry retention setting "${name}" must be an integer of at least 1.`);
  }
  const clock = options.clock ?? systemClock;
  const database = openTelemetryDatabase(options.directory);
  let writes = 0;

  /** Deletes telemetry beyond the retention limits every few hundred writes. */
  const maybePrune = (): void => {
    writes += 1;
    if (writes % pruneEvery !== 0)
      return;
    const cutoff = clock.now() - retention.maxAgeMs;
    database.transaction(() => {
      database.query("DELETE FROM spans WHERE end_time < ? OR seq <= (SELECT MAX(seq) FROM spans) - ?").run(cutoff, retention.maxSpans);
      database.query("DELETE FROM logs WHERE time < ? OR seq <= (SELECT MAX(seq) FROM logs) - ?").run(cutoff, retention.maxLogs);
      database.query("DELETE FROM metrics WHERE updated_at < ?").run(cutoff);
    })();
  };

  const insertSpan = database.query("INSERT INTO spans (trace_id, span_id, parent_span_id, name, start_time, end_time, status, service, invocation_id, delivery_id, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertLog = database.query("INSERT INTO logs (time, level, handler_id, invocation_id, correlation_id, trace_id, delivery_id, entry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const upsertMetric = database.query("INSERT INTO metrics (instance, service, name, series, updated_at, record) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (instance, name, series) DO UPDATE SET updated_at = excluded.updated_at, record = excluded.record, service = excluded.service");

  /**
   * Stores one collection of metrics as the latest points of their series.
   *
   * @param metrics - The cumulative metrics.
   * @param resource - Who reported them.
   */
  const storeMetrics = (metrics: readonly MetricRecord[], resource: TelemetryResource): void => {
    const instance = String(resource.attributes["service.instance.id"] ?? "unknown");
    const service = String(resource.attributes["service.name"] ?? "unknown");
    const now = clock.now();
    database.transaction(() => {
      for (const metric of metrics) {
        for (const point of metric.points)
          upsertMetric.run(instance, service, metric.name, seriesKey(point.attributes), now, JSON.stringify({ ...metric, points: [point] }));
      }
    })();
    maybePrune();
  };

  const exporter: TelemetryExporter = Object.freeze({
    name: "local",
    exportSpans: async (spans: readonly SpanRecord[], resource: TelemetryResource) => {
      // Never write on the caller's stack.
      await Promise.resolve();
      const service = String(resource.attributes["service.name"] ?? "unknown");
      database.transaction(() => {
        for (const span of spans) {
          const { attributes } = span;
          const invocationId = attributes["holqa.invocation.id"];
          const deliveryId = attributes["messaging.message.id"] ?? attributes["holqa.object_event.id"];
          insertSpan.run(span.traceId, span.spanId, span.parentSpanId ?? null, span.name, span.startTime, span.endTime, span.status.code, service, typeof invocationId === "string" ? invocationId : null, typeof deliveryId === "string" ? deliveryId : null, JSON.stringify(span));
        }
      })();
      maybePrune();
    },
    exportMetrics: async (metrics: readonly MetricRecord[], resource: TelemetryResource) => {
      await Promise.resolve();
      storeMetrics(metrics, resource);
    }
  });

  let closed = false;
  let queuedLogs: LogEntry[] = [];
  let droppedLogs = 0;
  let logTimer: ReturnType<typeof setTimeout> | undefined;
  let lastReport = Number.NEGATIVE_INFINITY;

  /** Writes queued log entries in one transaction; a failed write drops them and is reported on standard error, at most once a minute. */
  function flushLogs(): void {
    clearTimeout(logTimer);
    logTimer = undefined;
    const batch = queuedLogs;
    queuedLogs = [];
    if (batch.length === 0 && droppedLogs === 0)
      return;
    try {
      database.transaction(() => {
        for (const entry of batch) {
          /**
           * Reads a string field of the entry.
           *
           * @param name - The field's name.
           * @returns The value, or `null` when it is absent or not a string.
           */
          const text = (name: string): string | null => typeof entry[name] === "string" ? entry[name] : null;
          const time = Date.parse(entry.time);
          insertLog.run(Number.isFinite(time) ? time : clock.now(), entry.level, text("handlerId"), text("invocationId"), text("correlationId"), text("traceId"), text("deliveryId"), JSON.stringify(entry));
        }
      })();
      for (let index = 0; index < batch.length; index += 1)
        maybePrune();
    } catch (error) {
      droppedLogs += batch.length;
      if (performance.now() - lastReport > 60_000) {
        lastReport = performance.now();
        process.stderr.write(`holqa: ${droppedLogs} log entries were not stored in the local telemetry store (${error instanceof Error ? error.message : String(error)}).\n`);
        droppedLogs = 0;
      }
    }
  }

  const reader = createReader(database);
  return Object.freeze({
    ...reader,
    close: () => {
      flushLogs();
      closed = true;
      database.close();
    },
    exporter,
    writeLog: (entry: LogEntry) => {
      if (closed)
        return;
      if (queuedLogs.length >= maxQueuedLogs) {
        droppedLogs += 1;
        return;
      }
      queuedLogs.push(entry);
      if (logTimer === undefined) {
        logTimer = setTimeout(flushLogs, logFlushMs);
        (logTimer as { unref?: () => void }).unref?.();
      }
    },
    flushLogs,
    increment: (metric: FrameworkMetric, attributes: TelemetryAttributes = {}, by = 1) => {
      const instance = `${metric.name}:local`;
      const series = seriesKey(attributes);
      // Read and write in one immediate transaction, so concurrent processes never lose an increment.
      database.transaction(() => {
        const existing = database.query<{ record: string }, [string, string, string]>("SELECT record FROM metrics WHERE instance = ? AND name = ? AND series = ?").get(instance, metric.name, series);
        const stored = existing === null ? undefined : readMetricRecord(existing.record);
        const point = stored?.type === "sum" ? stored.points[0] : undefined;
        const now = clock.now();
        const record: MetricRecord = { type: "sum", monotonic: true, name: metric.name, description: metric.description, unit: metric.unit, points: [{ attributes, startTime: point?.startTime ?? now, time: now, value: (point?.value ?? 0) + by }] };
        upsertMetric.run(instance, "holqa", metric.name, series, now, JSON.stringify(record));
      }).immediate();
    }
  });
}

/**
 * Opens the telemetry of a local state directory for reading, without
 * creating or changing anything.
 *
 * @param directory - The local state directory.
 * @returns The reader, or `undefined` when no telemetry was recorded there yet.
 * @throws {HolqaError} `HOLQA_LOCAL_STATE_UNSUPPORTED` when a newer version wrote the store.
 */
export function openLocalTelemetryReader(directory: string): LocalTelemetryReader | undefined {
  const file = join(directory, telemetryFileName);
  if (!existsSync(file))
    return undefined;
  const database = new Database(file, { readonly: true, strict: true });
  try {
    const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version > telemetryStoreVersion)
      failWith(diagnosticCodes.localStateUnsupported, `The telemetry store in "${directory}" has format ${version}; this version of @holqa/local reads format ${telemetryStoreVersion}.`, "Use the Holqa version that wrote it.");
  } catch (error) {
    database.close();
    throw error;
  }
  return createReader(database);
}

/**
 * Builds the series key of a metric point: its attributes with sorted keys.
 *
 * @param attributes - The point's attributes.
 * @returns A stable JSON key.
 */
function seriesKey(attributes: TelemetryAttributes): string {
  return JSON.stringify(Object.fromEntries(Object.entries(attributes).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
}

/**
 * Creates the read operations over an open telemetry database.
 *
 * @param database - An open telemetry database, writable or read-only.
 * @returns Queries for logs, traces, spans and metrics.
 */
function createReader(database: Database): LocalTelemetryReader {
  return Object.freeze({
    logs: (query: LogQuery = {}) => {
      const conditions: string[] = [];
      const values: Array<string | number> = [];
      for (const [column, value] of [["handler_id", query.handlerId], ["trace_id", query.traceId], ["correlation_id", query.correlationId], ["delivery_id", query.deliveryId]] as const) {
        if (value !== undefined) {
          conditions.push(`${column} = ?`);
          values.push(value);
        }
      }
      if (query.level !== undefined) {
        const levels = Object.keys(severity).filter(level => severity[level]! >= severity[query.level!]!);
        conditions.push(`level IN (${levels.map(() => "?").join(", ")})`);
        values.push(...levels);
      }
      if (query.after !== undefined) {
        conditions.push("seq > ?");
        values.push(query.after);
      }
      const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
      const limit = query.limit ?? 100;
      // Following reads forward from a position; otherwise the newest entries, returned oldest first.
      const sql = query.after === undefined
        ? `SELECT * FROM (SELECT seq, entry FROM logs ${where} ORDER BY seq DESC LIMIT ?) ORDER BY seq`
        : `SELECT seq, entry FROM logs ${where} ORDER BY seq LIMIT ?`;
      return database.query<{ seq: number; entry: string }, Array<string | number>>(sql).all(...values, limit).flatMap((row) => {
        const entry = readLogEntry(row.entry);
        return entry === undefined ? [] : [Object.freeze({ seq: row.seq, entry })];
      });
    },
    traces: (limit = 20) => database.query<{ trace_id: string; start: number; end: number; spans: number; errors: number; root: string | null; first: string }, [number]>(`
      SELECT trace_id, MIN(start_time) AS start, MAX(end_time) AS end, COUNT(*) AS spans,
        SUM(status = 'error') AS errors,
        (SELECT name FROM spans AS r WHERE r.trace_id = s.trace_id AND r.parent_span_id IS NULL ORDER BY r.start_time LIMIT 1) AS root,
        (SELECT name FROM spans AS f WHERE f.trace_id = s.trace_id ORDER BY f.start_time LIMIT 1) AS first
      FROM spans AS s GROUP BY trace_id ORDER BY MAX(seq) DESC LIMIT ?`).all(limit).map(row => Object.freeze({
      traceId: row.trace_id,
      name: row.root ?? row.first,
      startTime: row.start,
      durationMs: row.end - row.start,
      spans: row.spans,
      errors: row.errors
    })),
    trace: (traceId: string) => database.query<{ record: string }, [string]>("SELECT record FROM spans WHERE trace_id = ? ORDER BY start_time, seq").all(traceId).flatMap(row => readSpanRecord(row.record) ?? []),
    matchTraceIds: (prefix: string) => /^[0-9a-f]{1,32}$/.test(prefix)
      ? database.query<{ trace_id: string }, [string, string]>("SELECT DISTINCT trace_id FROM spans WHERE trace_id >= ? AND trace_id < ? LIMIT 2").all(prefix, `${prefix}g`).map(row => row.trace_id)
      : [],
    spansOfDelivery: (deliveryId: string) => database.query<{ record: string }, [string]>("SELECT record FROM spans WHERE delivery_id = ? ORDER BY start_time, seq").all(deliveryId).flatMap(row => readSpanRecord(row.record) ?? []),
    metrics: () => aggregateMetrics(database.query<{ record: string; updated_at: number }, []>("SELECT record, updated_at FROM metrics ORDER BY updated_at").all().flatMap((row) => {
      const record = readMetricRecord(row.record);
      return record === undefined ? [] : [{ record, updatedAt: row.updated_at }];
    })),
    close: () => database.close()
  });
}

/**
 * Adds up the stored series of every instance: sums and histograms are
 * cumulative per instance, so their values add; a gauge keeps the most
 * recent value.
 *
 * @param rows - One single-point record per stored series, oldest report first.
 * @returns One record per metric, sorted by name, with one point per attribute set.
 */
function aggregateMetrics(rows: ReadonlyArray<{ readonly record: MetricRecord; readonly updatedAt: number }>): MetricRecord[] {
  const byName = new Map<string, { record: MetricRecord; points: Map<string, MetricRecord["points"][number]> }>();
  for (const { record } of rows) {
    const point = record.points[0];
    if (point === undefined)
      continue;
    // Writers that disagree on a metric's type keep separate records instead of mixing points.
    const metricKey = `${record.name}\u0000${record.type}`;
    let entry = byName.get(metricKey);
    if (entry === undefined) {
      entry = { record, points: new Map() };
      byName.set(metricKey, entry);
    }
    const key = seriesKey(point.attributes);
    const existing = entry.points.get(key);
    entry.points.set(key, existing === undefined || record.type === "gauge" ? point : addPoints(existing, point));
  }
  return [...byName.values()].map(({ record, points }) => ({ ...record, points: [...points.values()] }) as MetricRecord).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

/**
 * Adds two cumulative points of the same series.
 *
 * @param left - One instance's point.
 * @param right - Another instance's point.
 * @returns The combined point.
 */
function addPoints(left: MetricRecord["points"][number], right: MetricRecord["points"][number]): MetricRecord["points"][number] {
  if ("count" in left && "count" in right) {
    // Histograms with different boundaries cannot be added; the latest report wins.
    if (JSON.stringify(left.bounds) !== JSON.stringify(right.bounds))
      return right;
    return {
      ...right,
      startTime: Math.min(left.startTime, right.startTime),
      count: left.count + right.count,
      sum: left.sum + right.sum,
      min: Math.min(left.min, right.min),
      max: Math.max(left.max, right.max),
      bucketCounts: right.bucketCounts.map((count, index) => count + (left.bucketCounts[index] ?? 0))
    };
  }
  if ("value" in left && "value" in right)
    return { ...right, value: left.value + right.value };
  return right;
}

/**
 * Parses stored JSON without throwing.
 *
 * @param text - The stored text.
 * @returns The value, or `undefined` when it is not JSON.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A damaged row is skipped by the readers, which treat it as absent.
    return undefined;
  }
}

/**
 * Reports whether a value is a plain object.
 *
 * @param value - The candidate.
 * @returns `true` for non-array objects.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a stored log entry, checking the fields every entry has.
 *
 * @param text - The stored JSON.
 * @returns The entry, or `undefined` when the row is damaged or foreign.
 */
function readLogEntry(text: string): LogEntry | undefined {
  const value = parseJson(text);
  if (!isRecord(value))
    return undefined;
  const { message, time, level } = value;
  if (typeof message !== "string" || typeof time !== "string" || typeof level !== "string" || !["debug", "info", "warn", "error"].includes(level))
    return undefined;
  return Object.freeze(value) as LogEntry;
}

/**
 * Reads a stored span, checking its identity, timing, status and collections.
 *
 * @param text - The stored JSON.
 * @returns The span, or `undefined` when the row is damaged or foreign.
 */
function readSpanRecord(text: string): SpanRecord | undefined {
  const value = parseJson(text);
  if (!isRecord(value))
    return undefined;
  const { traceId, spanId, parentSpanId, name, kind, startTime, endTime, status, attributes, events, links } = value;
  const valid = isTraceId(traceId) && isSpanId(spanId) && (parentSpanId === undefined || isSpanId(parentSpanId))
    && typeof name === "string" && typeof kind === "string" && ["internal", "server", "client", "producer", "consumer"].includes(kind)
    && typeof startTime === "number" && typeof endTime === "number"
    && isSpanStatus(status)
    && isRecord(attributes) && Array.isArray(events) && Array.isArray(links);
  return valid ? Object.freeze(value) as unknown as SpanRecord : undefined;
}

/**
 * Reports whether a value is a span status.
 *
 * @param value - The stored status.
 * @returns `true` for an object whose `code` is `unset`, `ok` or `error`.
 */
function isSpanStatus(value: unknown): boolean {
  if (!isRecord(value))
    return false;
  const { code } = value;
  return code === "unset" || code === "ok" || code === "error";
}

/**
 * Reads a stored single-point metric record, checking its type and point.
 *
 * @param text - The stored JSON.
 * @returns The record, or `undefined` when the row is damaged or foreign.
 */
function readMetricRecord(text: string): MetricRecord | undefined {
  const value = parseJson(text);
  if (!isRecord(value))
    return undefined;
  const { name, type, points } = value;
  if (typeof name !== "string" || !Array.isArray(points))
    return undefined;
  const [point] = points as unknown[];
  if (!isRecord(point))
    return undefined;
  const { attributes, bounds, bucketCounts } = point;
  if (!isRecord(attributes))
    return undefined;
  /**
   * Reports whether a field of the point is a finite number.
   *
   * @param key - The field's name.
   * @returns `true` for finite numbers.
   */
  const numeric = (key: string): boolean => typeof point[key] === "number" && Number.isFinite(point[key]);
  const valid = type === "histogram"
    ? numeric("count") && numeric("sum") && numeric("min") && numeric("max") && Array.isArray(bounds) && Array.isArray(bucketCounts)
    : (type === "sum" || type === "gauge") && numeric("value");
  return valid ? Object.freeze(value) as unknown as MetricRecord : undefined;
}