import type {
  InvocationLogger,
  JsonObject,
  JsonValue,
  Redactor,
  TelemetryLogRecord
} from "@holqa/core";

import { createRedactor } from "@holqa/core";

/** Log severities, from least to most severe. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * One structured log entry. Runtime fields (`handlerId`, `invocationId`,
 * `correlationId`, ...) and the fields a handler passes sit next to `level`,
 * `time` and `message`; a field never replaces those three.
 */
export interface LogEntry {
  readonly level: LogLevel;
  /** ISO 8601 time the entry was written. */
  readonly time: string;
  readonly message: string;
  readonly [field: string]: JsonValue;
}

/** Receives every log entry. A sink must not throw; if it does, the runtime reports that on standard error. */
export type LogSink = (entry: LogEntry) => void;

/** The keys every entry owns; fields with these names are dropped from `fields`. */
const reservedKeys: ReadonlySet<string> = new Set(["level", "time", "message"]);

/**
 * Creates a sink that writes one JSON document per line, the format most log
 * collectors ingest directly.
 *
 * @param write - Receives each line including its newline; defaults to standard output.
 * @returns A sink that serializes each entry with `JSON.stringify`.
 */
export function jsonLineSink(write: (line: string) => void = line => process.stdout.write(line)): LogSink {
  return entry => write(`${JSON.stringify(entry)}\n`);
}

/** A sink that drops every entry, for tests and embedding. */
export const silentSink: LogSink = () => {};

/** Severity order, for level filtering. */
const severity: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Reports whether a value is a log level.
 *
 * @param value - The candidate.
 * @returns `true` for `debug`, `info`, `warn` and `error`.
 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.hasOwn(severity, value);
}

/** What every logger derived from one root logger shares. */
export interface LogSettings {
  /** Where entries go. */
  readonly sink: LogSink;
  /** Returns the current wall-clock time. */
  readonly clock: () => Date;
  /** The least severe level written. Default `debug`. */
  readonly level?: LogLevel;
  /** Removes sensitive fields and secret values from every entry. Default: the default sensitive field names. */
  readonly redactor?: Redactor;
  /** Also receives every written entry as a telemetry log record, for example to export it. */
  readonly onRecord?: (record: TelemetryLogRecord) => void;
}

/**
 * Writes structured entries with fixed context fields to a sink. Entries
 * below the configured level are dropped; every entry's message and fields
 * are redacted (sensitive field names, known secret values) before the sink
 * sees them.
 */
export class StructuredLogger {
  /** Shared settings. */
  private readonly settings: Required<Omit<LogSettings, "onRecord">> & Pick<LogSettings, "onRecord">;
  /** Fields added to every entry. */
  private readonly context: JsonObject;

  /**
   * Creates a logger.
   *
   * @param sink - Where entries go, or the complete settings.
   * @param context - Fields added to every entry, for example `{ handlerId, invocationId }`.
   * @param clock - Returns the current time; injectable for deterministic tests. Ignored when `sink` is settings.
   */
  constructor(sink: LogSink | LogSettings, context: JsonObject = {}, clock: () => Date = () => new Date()) {
    const settings: LogSettings = typeof sink === "function" ? { sink, clock } : sink;
    this.settings = { ...settings, level: settings.level ?? "debug", redactor: settings.redactor ?? createRedactor() };
    this.context = context;
  }

  /**
   * Creates a logger that adds more context fields to every entry.
   *
   * @param context - Extra fields; they replace existing fields of the same name.
   * @returns The new logger.
   */
  child(context: JsonObject): StructuredLogger {
    return new StructuredLogger(this.settings, { ...this.context, ...context });
  }

  /**
   * Reports whether entries of a level are written.
   *
   * @param level - The severity.
   * @returns `true` when the level is at or above the configured level.
   */
  enabled(level: LogLevel): boolean {
    return severity[level] >= severity[this.settings.level];
  }

  /**
   * Writes one entry. A sink that throws is reported on standard error rather
   * than failing the invocation that logged.
   *
   * @param level - The severity.
   * @param message - What happened.
   * @param fields - Structured data; keys named `level`, `time` or `message` are ignored.
   */
  write(level: LogLevel, message: string, fields: JsonObject = {}): void {
    if (!this.enabled(level))
      return;
    const { redactor, sink, onRecord } = this.settings;
    const time = this.settings.clock();
    const safeMessage = redactor.text(message);
    const merged: Record<string, JsonValue> = {};
    for (const source of [this.context, fields]) {
      for (const [key, value] of Object.entries(source)) {
        if (!reservedKeys.has(key))
          merged[key] = value;
      }
    }
    // Only the message and the fields are redacted: a secret that happens to
    // equal a level name or part of a timestamp must not corrupt them.
    const redacted: LogEntry = { level, time: time.toISOString(), message: safeMessage, ...redactor.object(merged) };
    try {
      sink(redacted);
    } catch (error) {
      process.stderr.write(`holqa: the log sink failed (${error instanceof Error ? error.message : String(error)}) while writing: ${safeMessage}\n`);
    }
    if (onRecord !== undefined) {
      const { level: _level, time: _time, message: _message, traceId, spanId, ...attributes } = redacted;
      onRecord({ time: time.getTime(), severity: level, body: safeMessage, attributes, ...typeof traceId === "string" ? { traceId } : {}, ...typeof spanId === "string" ? { spanId } : {} });
    }
  }

  /**
   * Returns the handler-facing view of this logger.
   *
   * @returns An {@link InvocationLogger} that writes through this logger.
   */
  forHandler(): InvocationLogger {
    return Object.freeze({
      debug: (message: string, fields?: JsonObject) => this.write("debug", message, fields),
      info: (message: string, fields?: JsonObject) => this.write("info", message, fields),
      warn: (message: string, fields?: JsonObject) => this.write("warn", message, fields),
      error: (message: string, fields?: JsonObject) => this.write("error", message, fields)
    });
  }
}

/**
 * Describes a caught error for logs: its name, message, stack and Holqa
 * diagnostics, and the same for its `cause` chain (up to a few levels).
 *
 * @param error - The caught value.
 * @param depth - How many causes to follow.
 * @returns JSON fields describing the error.
 */
export function describeError(error: unknown, depth = 3): JsonObject {
  if (!(error instanceof Error))
    return { value: String(error) };
  const diagnostics = "diagnostics" in error && Array.isArray(error.diagnostics)
    ? (error.diagnostics as ReadonlyArray<{ readonly code?: unknown; readonly message?: unknown }>).map(diagnostic => ({ code: String(diagnostic.code), message: String(diagnostic.message) }))
    : undefined;
  return {
    name: error.name,
    message: error.message,
    ...error.stack === undefined ? {} : { stack: error.stack },
    ...diagnostics === undefined ? {} : { diagnostics },
    ...depth > 0 && error.cause !== undefined ? { cause: describeError(error.cause, depth - 1) } : {}
  };
}