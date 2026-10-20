import type {
  JsonObject,
  JsonValue
} from "@holqa/core";

import type { DevEvent } from "@/dev/events";
import type { CliIo } from "@/io";

import { formatDiagnostic } from "@holqa/core";

import { isJsonObject } from "@/local/protocol";

/** Log fields shown in the line itself, or deliberately hidden. */
const knownFields: ReadonlySet<string> = new Set([
  "level",
  "time",
  "message",
  "application",
  "generation",
  "handlerId",
  "invocationId",
  "correlationId",
  "causationId",
  "triggerKind",
  "resourceId",
  "outcome",
  "code",
  "durationMs",
  "attempt",
  "deliveryId",
  "runId",
  "emitted",
  "error",
  "source",
  "transport",
  "method",
  "path",
  "traceId",
  "spanId"
]);

/**
 * Shortens an identifier for display.
 *
 * @param value - An identifier such as a UUID.
 * @returns Its first 8 characters.
 */
function short(value: string): string {
  return value.length > 12 ? value.slice(0, 8) : value;
}

/**
 * Reads a string field of a log entry.
 *
 * @param entry - The entry.
 * @param name - The field.
 * @returns The value, or `undefined`.
 */
function text(entry: JsonObject, name: string): string | undefined {
  const value = entry[name];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

/**
 * Finds the first stack frame of an error that belongs to the application,
 * not to Holqa or a dependency, so a failure points at the developer's code.
 *
 * @param stack - The error's stack.
 * @param root - The application root.
 * @returns The frame's location relative to the root, for example `src/orders.handler.ts:12:9`.
 */
export function applicationFrame(stack: string, root: string): string | undefined {
  for (const line of stack.split("\n").slice(1)) {
    const match = /\(?((?:file:\/\/)?\/[^():]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (match === null)
      continue;
    const file = match[1]!.replace(/^file:\/\//, "");
    if (file.startsWith(`${root}/`) && !file.includes("/node_modules/"))
      return `${file.slice(root.length + 1)}:${match[2]}:${match[3]}`;
  }
  return undefined;
}

/**
 * Formats one runtime log entry as a terminal line, with what triggered the
 * invocation, its trace, its outcome and what it emitted. Failures add the
 * error's message and the first application stack frame on further lines.
 *
 * @param entry - A structured log entry.
 * @param root - The application root, for stack frames.
 * @returns The text, possibly several lines.
 */
export function formatLogEntry(entry: JsonObject, root: string): string {
  const time = text(entry, "time")?.slice(11, 23) ?? "";
  const level = (text(entry, "level") ?? "info").padEnd(5);
  const who = text(entry, "handlerId") ?? "runtime";
  const parts: string[] = [time, level, who.padEnd(20), text(entry, "message") ?? ""];
  const code = text(entry, "code");
  if (code !== undefined)
    parts.push(code);
  const durationMs = entry["durationMs"];
  if (typeof durationMs === "number")
    parts.push(`${Math.round(durationMs)} ms`);
  const trigger = text(entry, "triggerKind");
  const resourceId = text(entry, "resourceId");
  const method = text(entry, "method");
  if (method !== undefined)
    parts.push(`${method} ${text(entry, "path") ?? ""}`);
  else if (trigger !== undefined)
    parts.push(`${trigger}${resourceId === undefined ? "" : ` ${resourceId}`}`);
  const attempt = text(entry, "attempt");
  if (attempt !== undefined)
    parts.push(`attempt ${attempt}`);
  const correlationId = text(entry, "correlationId");
  if (correlationId !== undefined)
    parts.push(`trace ${short(correlationId)}`);
  const causationId = text(entry, "causationId");
  if (causationId !== undefined)
    parts.push(`from ${short(causationId)}`);
  const traceId = text(entry, "traceId");
  if (traceId !== undefined)
    parts.push(`otel ${traceId.slice(0, 8)}`);
  const emitted = entry["emitted"];
  if (Array.isArray(emitted) && emitted.length > 0)
    parts.push(`-> ${emitted.map(describeEmitted).join(", ")}`);
  const extra = Object.entries(entry).filter(([key]) => !knownFields.has(key));
  if (extra.length > 0)
    parts.push(extra.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" "));
  const lines = [parts.filter(part => part !== "").join("  ")];
  const error = entry["error"];
  if (isJsonObject(error)) {
    const message = text(error, "message");
    const name = text(error, "name");
    if (message !== undefined)
      lines.push(`      ${name ?? "Error"}: ${message}`);
    const stack = text(error, "stack");
    const frame = stack === undefined ? undefined : applicationFrame(stack, root);
    const source = text(entry, "source");
    if (frame !== undefined)
      lines.push(`      at ${frame}`);
    else if (source !== undefined)
      lines.push(`      in ${source}`);
  }
  return lines.join("\n");
}

/**
 * Describes one emitted event.
 *
 * @param event - An entry of `emitted`.
 * @returns For example `queue orders 1a2b3c4d` or `created receipts/a.json`.
 */
function describeEmitted(event: JsonValue): string {
  if (!isJsonObject(event))
    return "?";
  if (event["type"] === "queue.message")
    return `queue ${String(event["resourceId"])} ${short(String(event["messageId"]))}`;
  return `${event["type"] === "object.deleted" ? "deleted" : "wrote"} ${String(event["resourceId"])}/${String(event["key"])}`;
}

/**
 * Creates the reporter of a dev session: JSON lines with `--json`, readable
 * text otherwise. Application output goes to standard error in text mode so
 * it never mixes with the session's own lines, and is wrapped in `output`
 * events in JSON mode.
 *
 * @param io - Output streams.
 * @param json - Whether to write JSON lines.
 * @param root - The application root, for stack frames.
 * @returns A function that reports one event.
 */
export function devReporter(io: CliIo, json: boolean, root: string): (event: DevEvent) => void {
  if (json)
    return event => io.stdout(JSON.stringify(event));
  // Warnings usually stay the same across reloads; repeat them only when they change.
  let lastWarnings = "";
  return (event) => {
    switch (event.type) {
      case "dev.listening":
        io.stdout([`holqa dev  ${event.url}`, `  state  ${event.stateDirectory}`, `  build  ${event.buildDirectory}`, event.watching ? "  Watching for changes. Press Ctrl+C to stop." : "  Not watching for changes. Press Ctrl+C to stop."].join("\n"));
        break;
      case "change":
        io.stdout(`\nchanged  ${event.files.join(", ")}`);
        break;
      case "build": {
        const { change } = event;
        const summary = change.kind === "initial"
          ? "first build"
          : change.kind === "implementation"
            ? "handler code changed; resources and contracts unchanged"
            : change.kind === "environment"
              ? "environment files changed"
              : [
                  change.kind === "resources" ? "resources changed" : "handlers changed",
                  ...describeChanges("resource", change.resources),
                  ...describeChanges("config", change.config),
                  ...describeChanges("handler", change.handlers)
                ].join("; ");
        io.stdout(`build    generation ${event.generation}: ${summary} (${event.durationMs} ms)`);
        const warnings = event.diagnostics.map(formatDiagnostic).join("\n");
        if (warnings !== "" && warnings !== lastWarnings)
          io.stderr(warnings);
        lastWarnings = warnings;
        break;
      }
      case "build.failed":
      case "generation.failed":
        io.stderr(event.diagnostics.map(formatDiagnostic).join("\n"));
        break;
      case "generation.ready":
        io.stdout(formatReady(event));
        break;
      case "generation.stopped":
        break;
      case "generation.exited":
        io.stderr(`generation ${event.generation} exited with code ${String(event.exitCode)}; save a file to restart it.`);
        break;
      case "log":
        io.stdout(formatLogEntry(event.entry, root));
        break;
      case "output":
        io.stderr(`  | ${event.line}`);
        break;
      case "dev.stopped":
        io.stdout("holqa dev stopped.");
        break;
    }
  };
}

/**
 * Describes added, removed and changed identities.
 *
 * @param noun - What they are.
 * @param changes - The changes.
 * @param changes.added - Added identities.
 * @param changes.removed - Removed identities.
 * @param changes.changed - Changed identities.
 * @returns One phrase per non-empty list.
 */
function describeChanges(noun: string, changes: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] }): string[] {
  return [
    ...changes.added.length === 0 ? [] : [`added ${noun} ${changes.added.join(", ")}`],
    ...changes.removed.length === 0 ? [] : [`removed ${noun} ${changes.removed.join(", ")} (its local state is kept)`],
    ...changes.changed.length === 0 ? [] : [`changed ${noun} ${changes.changed.join(", ")}`]
  ];
}

/**
 * Formats the banner of a ready generation.
 *
 * @param event - The event.
 * @returns The text.
 */
function formatReady(event: Extract<DevEvent, { readonly type: "generation.ready" }>): string {
  const { summary } = event;
  const lines = [`ready    generation ${event.generation} of "${summary.application}" (process ${event.pid}, ${event.durationMs} ms)`];
  lines.push(`  Resources (${summary.resources.length})`);
  for (const resource of summary.resources)
    lines.push(`    ${resource.kind.padEnd(8)}  ${resource.id.padEnd(20)}  ${resource.details}`);
  lines.push(`  Handlers (${summary.handlers.length})`);
  for (const handler of summary.handlers)
    lines.push(`    ${handler.id.padEnd(24)}  ${(handler.endpoint ?? `${handler.trigger} <- ${handler.resourceId}`).padEnd(36)}  ${handler.source}`);
  for (const schedule of summary.schedules)
    lines.push(`  Next run of ${schedule.id}: ${schedule.nextRun ?? "never"}`);
  return lines.join("\n");
}