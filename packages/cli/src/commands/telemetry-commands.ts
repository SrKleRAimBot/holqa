import type {
  Diagnostic,
  JsonObject,
  SpanRecord
} from "@holqa/core";
import type {
  DeliveryHistory,
  LocalTelemetryReader,
  StoredLogEntry
} from "@holqa/local";
import type { LogLevel } from "@holqa/runtime-bun";

import type { CliHost } from "@/analysis/host";
import type { OptionSpec } from "@/arguments";
import type { CliIo } from "@/io";

import {
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf,
  isHolqaError,
  parseTraceparent
} from "@holqa/core";

import { parseOptions } from "@/arguments";
import { reportDiagnostics } from "@/commands/analysis-command";
import { exitCodes } from "@/exit-codes";
import { locateApp } from "@/local/locations";
import { formatLogEntry } from "@/output/dev-output";
import {
  formatTraceTable,
  formatTraceTree,
  summarizeMetrics
} from "@/output/telemetry-output";

/** The commands this module implements, by their words. */
export const telemetryCommandNames = ["logs", "traces list", "traces inspect", "events inspect", "metrics"] as const;

/** One of {@link telemetryCommandNames}. */
export type TelemetryCommandName = (typeof telemetryCommandNames)[number];

/** Options shared by every telemetry command. */
const common = ["app", "state-dir"];

/** The options of each telemetry command. */
export const telemetryCommandOptions: Readonly<Record<TelemetryCommandName, OptionSpec>> = {
  "logs": { flags: ["follow"], values: [...common, "handler", "trace", "level", "limit"] },
  "traces list": { flags: [], values: [...common, "limit"] },
  "traces inspect": { flags: [], values: common, positionals: ["trace-id"] },
  "events inspect": { flags: [], values: common, positionals: ["event-id"] },
  "metrics": { flags: [], values: common }
};

/** How often `holqa logs --follow` looks for new entries, in milliseconds. */
const followIntervalMs = 500;

/** Log levels, for validating `--level`. */
const levels: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * Finds the telemetry command whose words start the arguments.
 *
 * @param args - The arguments, without `--json`.
 * @returns The command and the arguments after its words, or `undefined`.
 */
export function matchTelemetryCommand(args: readonly string[]): { readonly name: TelemetryCommandName; readonly rest: readonly string[] } | undefined {
  for (const name of telemetryCommandNames) {
    const words = name.split(" ");
    if (words.every((word, index) => args[index] === word))
      return { name, rest: args.slice(words.length) };
  }
  return undefined;
}

/**
 * Runs a telemetry command against the local telemetry store of the
 * application's state directory. The store is read-only for these commands
 * and may be written by a running dev session at the same time.
 *
 * @param host - The CLI host.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param name - Which command runs.
 * @param rest - The arguments after the command's words.
 * @returns The exit code.
 */
export async function telemetryCommand(host: CliHost, io: CliIo, json: boolean, name: TelemetryCommandName, rest: readonly string[]): Promise<number> {
  const parsed = parseOptions(rest, telemetryCommandOptions[name]);
  if (!parsed.ok)
    return usage(io, json, name, parsed.problems);
  const { values, flags, positionals } = parsed;
  const limitText = values.get("limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1 && limit <= 10_000))
    return usage(io, json, name, ["The option \"--limit\" must be a whole number between 1 and 10000."]);
  const level = values.get("level");
  if (level !== undefined && !levels.includes(level as LogLevel))
    return usage(io, json, name, [`The option "--level" must be one of ${levels.join(", ")}.`]);
  if (host.telemetry === undefined || (flags.has("follow") && host.waitForStop === undefined)) {
    reportDiagnostics(io, json, [createDiagnostic({ code: diagnosticCodes.localOperationFailed, severity: "error", message: `"holqa ${name}${flags.has("follow") ? " --follow" : ""}" is not available in this environment.` })]);
    return exitCodes.failure;
  }
  const location = locateApp(host.cwd, values.get("app"), values.get("state-dir"));
  let reader: LocalTelemetryReader | undefined;
  try {
    reader = host.telemetry(location.stateDir);
    switch (name) {
      case "logs":
        return await logs(host, io, json, reader, location.root, { ...values.has("handler") ? { handlerId: values.get("handler")! } : {}, ...values.has("trace") ? { traceId: values.get("trace")! } : {}, ...level === undefined ? {} : { level: level as LogLevel }, ...limit === undefined ? {} : { limit } }, flags.has("follow"), location.stateDir);
      case "traces list": {
        const traces = reader?.traces(limit ?? 20) ?? [];
        if (json)
          io.stdout(JSON.stringify({ traces }));
        else
          io.stdout(traces.length === 0 ? nothingRecorded(location.stateDir, "traces") : formatTraceTable(traces));
        return exitCodes.success;
      }
      case "traces inspect":
        return inspectTrace(io, json, reader, positionals[0]!);
      case "events inspect":
        return inspectEvent(host, io, json, reader, location.stateDir, location.root, positionals[0]!);
      case "metrics": {
        const metrics = reader?.metrics() ?? [];
        if (json)
          io.stdout(JSON.stringify({ metrics }));
        else
          io.stdout(metrics.length === 0 ? nothingRecorded(location.stateDir, "metrics") : summarizeMetrics(metrics));
        return exitCodes.success;
      }
    }
  } catch (error) {
    // A store written by a newer version, locked or damaged beyond reading: report, never crash.
    const diagnostics = diagnosticsOf(error);
    reportDiagnostics(io, json, diagnostics.length > 0 && isHolqaError(error)
      ? diagnostics
      : [createDiagnostic({ code: diagnosticCodes.localOperationFailed, severity: "error", message: `Reading the local telemetry in ${location.stateDir} failed: ${error instanceof Error ? error.message : String(error)}` })]);
    return exitCodes.failure;
  } finally {
    reader?.close();
  }
  return exitCodes.success;
}

/** Which log entries `holqa logs` prints. */
interface LogFilter {
  readonly handlerId?: string;
  readonly traceId?: string;
  readonly level?: LogLevel;
  readonly limit?: number;
}

/**
 * Prints recent log entries and, with `--follow`, new ones until stopped.
 *
 * @param host - The CLI host, for waiting and reopening the store.
 * @param io - Output streams.
 * @param json - Whether to print JSON lines.
 * @param initial - The reader, or `undefined` when nothing was recorded yet.
 * @param root - The application root, for stack frames.
 * @param filter - Which entries to print.
 * @param follow - Whether to keep printing new entries.
 * @param stateDir - The state directory, reopened while following until telemetry exists.
 * @returns The exit code.
 */
async function logs(host: CliHost, io: CliIo, json: boolean, initial: LocalTelemetryReader | undefined, root: string, filter: LogFilter, follow: boolean, stateDir: string): Promise<number> {
  /**
   * Prints entries.
   *
   * @param entries - Stored entries, oldest first.
   */
  const print = (entries: readonly StoredLogEntry[]): void => {
    for (const { entry } of entries)
      io.stdout(json ? JSON.stringify(entry) : formatLogEntry(entry, root));
  };
  let reader = initial;
  let last = 0;
  const first = reader?.logs({ ...filter, limit: filter.limit ?? 100 }) ?? [];
  print(first);
  last = first.at(-1)?.seq ?? reader?.logs({ limit: 1 }).at(-1)?.seq ?? 0;
  if (!follow) {
    if (first.length === 0 && !json)
      io.stdout(nothingRecorded(stateDir, "log entries"));
    return exitCodes.success;
  }
  try {
    while (!await host.waitForStop!(followIntervalMs)) {
      // A dev session started after the command creates the store; pick it up.
      reader ??= host.telemetry!(stateDir);
      if (reader === undefined)
        continue;
      const next = reader.logs({ ...filter, after: last, limit: 1_000 });
      print(next);
      last = next.at(-1)?.seq ?? last;
    }
  } finally {
    if (reader !== initial)
      reader?.close();
  }
  return exitCodes.success;
}

/**
 * Prints one trace as a tree of spans with a timeline.
 *
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param reader - The telemetry reader.
 * @param requested - The trace identifier or an unambiguous prefix of it.
 * @returns The exit code.
 */
function inspectTrace(io: CliIo, json: boolean, reader: LocalTelemetryReader | undefined, requested: string): number {
  const matches = reader?.matchTraceIds(requested.toLowerCase()) ?? [];
  if (matches.length > 1) {
    reportDiagnostics(io, json, [createDiagnostic({ code: diagnosticCodes.cliArgumentInvalid, severity: "error", message: `The trace identifier prefix "${requested}" matches more than one trace.`, hint: "Pass more characters of the trace identifier." })]);
    return exitCodes.usage;
  }
  const traceId = matches[0];
  const spans = traceId === undefined ? [] : reader!.trace(traceId);
  if (traceId === undefined || spans.length === 0) {
    reportDiagnostics(io, json, [notFound(`No trace "${requested}" is recorded in the local telemetry store.`, "Run \"holqa traces list\" to see recorded traces. Traces are kept for a day, and only while telemetry is recorded (holqa dev and the operation commands record it).")]);
    return exitCodes.failure;
  }
  io.stdout(json ? JSON.stringify({ traceId, spans }) : formatTraceTree(traceId, spans));
  return exitCodes.success;
}

/**
 * Prints what is known about one queue message or object event: its
 * delivery state and lineage from the local state, the invocations that
 * processed it and their logs, and its processing spans.
 *
 * @param host - The CLI host, for the local state.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param reader - The telemetry reader.
 * @param stateDir - The state directory.
 * @param root - The application root, for stack frames.
 * @param id - The message or event identifier.
 * @returns The exit code.
 */
function inspectEvent(host: CliHost, io: CliIo, json: boolean, reader: LocalTelemetryReader | undefined, stateDir: string, root: string, id: string): number {
  const history = host.deliveryHistory?.(stateDir, id);
  const entries = reader?.logs({ deliveryId: id, limit: 1_000 }).map(stored => stored.entry) ?? [];
  const spans = reader?.spansOfDelivery(id) ?? [];
  if (history === undefined && entries.length === 0 && spans.length === 0) {
    reportDiagnostics(io, json, [notFound(`No queue message or object event "${id}" is recorded in ${stateDir}.`, "Pass a message identifier (as printed by \"holqa queue send\" or \"holqa state\") or an object event identifier.")]);
    return exitCodes.failure;
  }
  if (json) {
    io.stdout(JSON.stringify({ id, ...history === undefined ? {} : { history }, invocations: invocationsOf(entries), logs: entries, spans }));
    return exitCodes.success;
  }
  io.stdout(formatEvent(id, history, entries, spans, root));
  return exitCodes.success;
}

/**
 * Reads the finished invocations from log entries.
 *
 * @param entries - The entries about one delivery.
 * @returns One summary per finished invocation, in order.
 */
function invocationsOf(entries: readonly JsonObject[]): JsonObject[] {
  return entries.filter(({ message }) => message === "invocation completed" || message === "invocation failed").map((entry) => {
    const fields: Record<string, JsonObject[string]> = {};
    for (const key of ["invocationId", "handlerId", "attempt", "outcome", "code", "durationMs", "traceId", "spanId", "time", "causationId", "rootId", "depth"]) {
      if (entry[key] !== undefined)
        fields[key] = entry[key]!;
    }
    return fields;
  });
}

/**
 * Formats the text output of `holqa events inspect`.
 *
 * @param id - The message or event identifier.
 * @param history - What the local state records, if anything.
 * @param entries - The log entries about it.
 * @param spans - Its processing and publishing spans.
 * @param root - The application root, for stack frames.
 * @returns The text.
 */
function formatEvent(id: string, history: DeliveryHistory | undefined, entries: readonly JsonObject[], spans: readonly SpanRecord[], root: string): string {
  const lines: string[] = [];
  const event = history?.objectEvent;
  lines.push(event === undefined ? `event ${id}` : `event ${id}  ${event.type} ${event.bucket}/${event.key} at ${event.time}`);
  for (const delivery of history?.deliveries ?? []) {
    const target = delivery.kind === "queue.message" ? `queue ${delivery.resourceId}` : `bucket ${delivery.resourceId} -> ${delivery.subscription ?? "?"}`;
    lines.push(`  ${target}: ${delivery.state === "dead" ? "dead-lettered" : delivery.state}, ${delivery.attempts} attempt${delivery.attempts === 1 ? "" : "s"}, sent ${delivery.sentAt}`);
    const { trace } = delivery;
    if (trace !== undefined)
      lines.push(`    lineage: correlation ${trace.correlationId}${trace.causationId === undefined ? "" : `, caused by ${trace.causationId}`}${trace.rootId === undefined ? "" : `, root ${trace.rootId}, depth ${trace.depth}`}${parseTraceparent(trace.traceparent) === undefined ? "" : `, published in trace ${parseTraceparent(trace.traceparent)!.traceId}`}`);
    if (delivery.lastError !== undefined)
      lines.push(`    last error: ${delivery.lastError.code} ${delivery.lastError.message}${delivery.lastError.invocationId === undefined ? "" : ` (invocation ${delivery.lastError.invocationId})`}`);
  }
  const invocations = invocationsOf(entries);
  if (invocations.length > 0) {
    lines.push("", "invocations:");
    for (const { attempt, outcome, code, durationMs, invocationId, traceId } of invocations)
      lines.push(`  attempt ${String(attempt ?? "?")}  ${String(outcome ?? "?")}${code === undefined ? "" : `  ${String(code)}`}  ${typeof durationMs === "number" ? `${Math.round(durationMs)} ms` : ""}  ${String(invocationId ?? "")}${traceId === undefined ? "" : `  trace ${String(traceId)}`}`);
  }
  if (spans.length > 0) {
    lines.push("", "spans:");
    for (const span of spans)
      lines.push(`  ${span.name}  ${span.kind}  ${Math.round(span.endTime - span.startTime)} ms  ${span.status.code}${span.status.code === "error" && span.status.message !== undefined ? ` ${span.status.message}` : ""}  trace ${span.traceId}`);
  }
  if (entries.length > 0) {
    lines.push("", "log:");
    for (const entry of entries)
      lines.push(...formatLogEntry(entry, root).split("\n").map(line => `  ${line}`));
  }
  return lines.join("\n");
}

/**
 * Builds a `HOLQA_TELEMETRY_NOT_FOUND` error.
 *
 * @param message - What was not found.
 * @param hint - How to find it.
 * @returns The diagnostic.
 */
function notFound(message: string, hint: string): Diagnostic {
  return createDiagnostic({ code: diagnosticCodes.telemetryNotFound, severity: "error", message, hint });
}

/**
 * Explains that nothing was recorded yet.
 *
 * @param stateDir - The state directory.
 * @param what - What is missing, for example `traces`.
 * @returns The message.
 */
function nothingRecorded(stateDir: string, what: string): string {
  return `No ${what} are recorded in ${stateDir} yet. Run "holqa dev" or an operation command such as "holqa invoke" first.`;
}

/**
 * Reports usage errors.
 *
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param name - The command.
 * @param problems - What is wrong with the arguments.
 * @returns The usage exit code.
 */
function usage(io: CliIo, json: boolean, name: string, problems: readonly string[]): number {
  reportDiagnostics(io, json, problems.map(problem => createDiagnostic({ code: diagnosticCodes.cliArgumentInvalid, severity: "error", message: `holqa ${name}: ${problem}`, hint: `Run "holqa --help" for the options of "holqa ${name}".` })));
  return exitCodes.usage;
}