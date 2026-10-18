import type {
  InvocationLogger,
  JsonObject,
  JsonValue
} from "@holqa/core";

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

/**
 * Writes structured entries with fixed context fields to a sink.
 */
export class StructuredLogger {
  /** Where entries go. */
  private readonly sink: LogSink;
  /** Fields added to every entry. */
  private readonly context: JsonObject;
  /** Returns the current wall-clock time. */
  private readonly clock: () => Date;

  /**
   * Creates a logger.
   *
   * @param sink - Where entries go.
   * @param context - Fields added to every entry, for example `{ handlerId, invocationId }`.
   * @param clock - Returns the current time; injectable for deterministic tests.
   */
  constructor(sink: LogSink, context: JsonObject = {}, clock: () => Date = () => new Date()) {
    this.sink = sink;
    this.context = context;
    this.clock = clock;
  }

  /**
   * Creates a logger that adds more context fields to every entry.
   *
   * @param context - Extra fields; they replace existing fields of the same name.
   * @returns The new logger.
   */
  child(context: JsonObject): StructuredLogger {
    return new StructuredLogger(this.sink, { ...this.context, ...context }, this.clock);
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
    const entry: Record<string, JsonValue> = { level, time: this.clock().toISOString(), message };
    for (const source of [this.context, fields]) {
      for (const [key, value] of Object.entries(source)) {
        if (!reservedKeys.has(key))
          entry[key] = value;
      }
    }
    try {
      this.sink(entry as LogEntry);
    } catch (error) {
      process.stderr.write(`holqa: the log sink failed (${error instanceof Error ? error.message : String(error)}) while writing: ${message}\n`);
    }
  }

  /**
   * Returns the handler-facing view of this logger.
   *
   * @returns An {@link InvocationLogger} that writes through this logger.
   */
  forHandler(): InvocationLogger {
    return Object.freeze({
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