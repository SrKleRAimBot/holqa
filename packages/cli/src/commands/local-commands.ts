import type {
  Diagnostic,
  JsonValue
} from "@holqa/core";

import type { CliHost } from "@/analysis/host";
import type { OptionSpec } from "@/arguments";
import type { CliIo } from "@/io";
import type { OperateOutcome } from "@/local/local-host";
import type { LocalOperation } from "@/local/protocol";
import {
  basename,
  resolve
} from "node:path";

import {
  createDiagnostic,
  diagnosticCodes,
  formatDiagnostic
} from "@holqa/core";

import { readDiagnostic } from "@/analysis/report";
import { parseOptions } from "@/arguments";
import { reportDiagnostics } from "@/commands/analysis-command";
import { exitCodes } from "@/exit-codes";
import { locateApp } from "@/local/locations";
import { maxPutBytes } from "@/local/operations";
import { isJsonObject } from "@/local/protocol";
import {
  devReporter,
  formatLogEntry
} from "@/output/dev-output";

/** The commands this module implements, by their words. */
export const localCommandNames = ["dev", "invoke", "queue send", "storage put", "cron run", "state", "doctor"] as const;

/** One of {@link localCommandNames}. */
export type LocalCommandName = (typeof localCommandNames)[number];

/** Options shared by every local command. */
const common = ["app", "state-dir"];

/** The options of each local command. */
export const localCommandOptions: Readonly<Record<LocalCommandName, OptionSpec>> = {
  "dev": { flags: ["no-watch"], values: [...common, "port", "host"] },
  "invoke": { flags: [], values: [...common, "input", "attempt"], positionals: ["handler"] },
  "queue send": { flags: [], values: [...common, "data", "delay"], positionals: ["queue"] },
  "storage put": { flags: [], values: [...common, "key", "content-type"], positionals: ["bucket", "file"] },
  "cron run": { flags: [], values: common, positionals: ["schedule"] },
  "state": { flags: [], values: common },
  "doctor": { flags: [], values: [...common, "port", "host"] }
};

/**
 * Finds the local command whose words start the arguments.
 *
 * @param args - The arguments, without `--json`.
 * @returns The command and the arguments after its words, or `undefined`.
 */
export function matchLocalCommand(args: readonly string[]): { readonly name: LocalCommandName; readonly rest: readonly string[] } | undefined {
  for (const name of localCommandNames) {
    const words = name.split(" ");
    if (words.every((word, index) => args[index] === word))
      return { name, rest: args.slice(words.length) };
  }
  return undefined;
}

/**
 * Runs a local command: `holqa dev`, an operation command, `holqa state` or `holqa doctor`.
 *
 * @param host - The CLI host.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param name - Which local command runs.
 * @param rest - The arguments after the command's words.
 * @returns The exit code.
 */
export async function localCommand(host: CliHost, io: CliIo, json: boolean, name: LocalCommandName, rest: readonly string[]): Promise<number> {
  const parsed = parseOptions(rest, localCommandOptions[name]);
  if (!parsed.ok)
    return usage(io, json, name, parsed.problems);
  const { values, flags, positionals } = parsed;
  const location = locateApp(host.cwd, values.get("app"), values.get("state-dir"));
  const port = values.has("port") ? integer(values.get("port")!, 0, 65_535) : 3000;
  if (port === undefined)
    return usage(io, json, name, ["The option \"--port\" must be a whole number between 0 and 65535."]);
  const hostname = values.get("host") ?? "127.0.0.1";

  if (name === "dev") {
    if (host.dev === undefined)
      return unavailable(io, json, name);
    const result = await host.dev({ location, port, hostname, watch: !flags.has("no-watch") }, devReporter(io, json, location.root));
    if (!result.ok) {
      reportDiagnostics(io, json, result.diagnostics);
      return exitCodes.failure;
    }
    return exitCodes.success;
  }

  if (name === "doctor") {
    if (host.doctor === undefined)
      return unavailable(io, json, name);
    const checks = await host.doctor({ location, port, hostname });
    const errors = checks.flatMap(check => check.status !== "error"
      ? []
      : [createDiagnostic({ code: diagnosticCodes.doctorCheckFailed, severity: "error", message: `${check.name}: ${check.message}` }), ...readDiagnostics(check.diagnostics)]);
    io.stdout(json
      ? JSON.stringify({ checks, diagnostics: errors })
      : checks.map(check => `${check.status === "ok" ? "ok     " : check.status === "warning" ? "warning" : "error  "}  ${check.name.padEnd(14)}  ${check.message}${readDiagnostics(check.diagnostics).map(diagnostic => `\n           ${formatDiagnostic(diagnostic).split("\n").join("\n           ")}`).join("")}`).join("\n"));
    if (errors.length > 0) {
      if (json)
        reportDiagnostics(io, json, errors);
      return exitCodes.failure;
    }
    return exitCodes.success;
  }

  const operation = await buildOperation(host, io, json, name, values, positionals);
  if (typeof operation === "number")
    return operation;
  if (host.operate === undefined)
    return unavailable(io, json, name);
  const outcome = await host.operate(location, operation);
  return reportOperation(io, json, location.root, operation, outcome);
}

/**
 * Builds the operation of an operation command from its arguments.
 *
 * @param host - The CLI host, for reading files.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param name - The command.
 * @param values - The option values.
 * @param positionals - The positional arguments.
 * @returns The operation, or the exit code after reporting a problem.
 */
async function buildOperation(host: CliHost, io: CliIo, json: boolean, name: Exclude<LocalCommandName, "dev" | "doctor">, values: ReadonlyMap<string, string>, positionals: readonly string[]): Promise<LocalOperation | number> {
  switch (name) {
    case "invoke": {
      const input = values.has("input") ? parseJson(values.get("input")!) : undefined;
      if (input === null)
        return usage(io, json, name, ["The option \"--input\" must be JSON, for example '{\"orderId\":\"123\"}'."]);
      const attempt = values.has("attempt") ? integer(values.get("attempt")!, 1, Number.MAX_SAFE_INTEGER) : undefined;
      if (values.has("attempt") && attempt === undefined)
        return usage(io, json, name, ["The option \"--attempt\" must be a whole number of at least 1."]);
      return { kind: "invoke", handlerId: positionals[0]!, ...input === undefined ? {} : { input: input.value }, ...attempt === undefined ? {} : { attempt } };
    }
    case "queue send": {
      if (!values.has("data"))
        return usage(io, json, name, ["The option \"--data\" is required: the message as JSON."]);
      const data = parseJson(values.get("data")!);
      if (data === null)
        return usage(io, json, name, ["The option \"--data\" must be JSON, for example '{\"orderId\":\"123\"}'."]);
      const delay = values.has("delay") ? integer(values.get("delay")!, 0, Number.MAX_SAFE_INTEGER) : undefined;
      if (values.has("delay") && delay === undefined)
        return usage(io, json, name, ["The option \"--delay\" must be a whole number of seconds of at least 0."]);
      return { kind: "queue.send", queueId: positionals[0]!, message: data.value, ...delay === undefined || delay === 0 ? {} : { delaySeconds: delay } };
    }
    case "storage put": {
      const path = resolve(host.cwd, positionals[1]!);
      if (host.readFile === undefined)
        return unavailable(io, json, name);
      let body: Uint8Array;
      try {
        body = await host.readFile(path);
      } catch (error) {
        reportDiagnostics(io, json, [createDiagnostic({ code: diagnosticCodes.fileUnreadable, severity: "error", message: `Cannot read "${positionals[1]}": ${error instanceof Error ? error.message : String(error)}` })]);
        return exitCodes.failure;
      }
      if (body.length > maxPutBytes) {
        reportDiagnostics(io, json, [createDiagnostic({ code: diagnosticCodes.operationInvalid, severity: "error", message: `"${positionals[1]}" is ${body.length} bytes; holqa storage put sends at most ${maxPutBytes}.`, hint: "Upload large objects through a signed URL instead." })]);
        return exitCodes.failure;
      }
      const contentType = values.get("content-type") ?? Bun.file(path).type.split(";")[0]!;
      return { kind: "storage.put", bucketId: positionals[0]!, key: values.get("key") ?? basename(path), contentType, body: Buffer.from(body).toString("base64") };
    }
    case "cron run":
      return { kind: "cron.run", scheduleId: positionals[0]! };
    case "state":
      return { kind: "state" };
  }
}

/**
 * Reports the outcome of an operation and chooses the exit code: `0` when it
 * succeeded, `1` when it failed, including a handler that failed or a
 * scheduled run that failed. Successful output is one JSON document on
 * standard output with `--json`; failures also write `{"diagnostics":[...]}`
 * to standard error.
 *
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param root - The application root, for stack frames.
 * @param operation - The operation that produced the result.
 * @param outcome - What it produced.
 * @returns The exit code.
 */
function reportOperation(io: CliIo, json: boolean, root: string, operation: LocalOperation, outcome: OperateOutcome): number {
  if (!json && outcome.output !== "")
    io.stderr(outcome.output.split("\n").map(line => `  | ${line}`).join("\n"));
  if (!json && outcome.warnings.length > 0)
    io.stderr(outcome.warnings.map(formatDiagnostic).join("\n"));
  const { response } = outcome;
  if (!response.ok) {
    reportDiagnostics(io, json, response.diagnostics);
    return exitCodes.failure;
  }
  const { result } = response;
  const failure = failureOf(operation, fields(result));
  if (json)
    io.stdout(JSON.stringify({ target: outcome.target, ...result, ...outcome.output === "" ? {} : { output: outcome.output } }));
  else
    io.stdout(describeResult(operation, fields(result), outcome.target, root));
  if (failure.length > 0) {
    if (json)
      reportDiagnostics(io, json, failure);
    else
      io.stderr(failure.map(formatDiagnostic).join("\n"));
    return exitCodes.failure;
  }
  return exitCodes.success;
}

/** The names of the result fields the CLI reads to describe operations. */
type FieldName = "outcome" | "ok" | "failure" | "diagnostics" | "code" | "message" | "handlerId" | "invocationId" | "correlationId" | "run" | "status" | "runId" | "durationMs" | "value" | "messageId" | "queueId" | "object" | "bucketId" | "key" | "size" | "contentType" | "application" | "queues" | "counts" | "id" | "messages" | "state" | "lastError" | "attempts" | "buckets" | "objects" | "lastModified" | "events" | "event" | "deliveries" | "subscription" | "type" | "schedules" | "cron" | "timezone" | "nextRun" | "runs" | "scheduledTime" | "trigger" | "logs";

/** An unchecked view of a JSON result: every field the CLI reads, as `unknown`. */
type Fields = { readonly [Name in FieldName]?: unknown };

/**
 * Views a JSON value as result fields.
 *
 * @param value - Part of an operation result.
 * @returns The value's fields, or no fields when it is not an object.
 */
function fields(value: unknown): Fields {
  return isJsonObject(value) ? value as Fields : {};
}

/**
 * Finds the failure inside a successful operation: a failed invocation or a failed scheduled run.
 *
 * @param operation - The operation whose result is checked.
 * @param result - Its result.
 * @returns The diagnostics of the failure; empty when there is none.
 */
function failureOf(operation: LocalOperation, result: Fields): Diagnostic[] {
  if (operation.kind === "invoke") {
    const outcome = fields(result.outcome);
    if (outcome?.ok !== false)
      return [];
    const failure = fields(outcome.failure);
    const causes = readDiagnostics(failure.diagnostics).filter(diagnostic => diagnostic.code !== failure.code);
    return [createDiagnostic({ code: failure.code as Diagnostic["code"], severity: "error", message: String(failure.message), details: { handlerId: String(outcome.handlerId), invocationId: String(outcome.invocationId), correlationId: String(outcome.correlationId) } }), ...causes];
  }
  if (operation.kind === "cron.run") {
    const run = fields(result.run);
    if (run?.status !== "failed")
      return [];
    return [createDiagnostic({ code: (typeof run.code === "string" ? run.code : diagnosticCodes.handlerFailed) as Diagnostic["code"], severity: "error", message: `The run of schedule "${operation.scheduleId}" failed: ${String(run.message ?? "")}`, details: { runId: String(run.runId), ...typeof run.invocationId === "string" ? { invocationId: run.invocationId } : {} } })];
  }
  return [];
}

/**
 * Describes an operation's result for a terminal.
 *
 * @param operation - The operation that produced the result.
 * @param result - Its result.
 * @param target - Where it ran.
 * @param root - The application root, for stack frames.
 * @returns The text.
 */
function describeResult(operation: LocalOperation, result: Fields, target: string, root: string): string {
  const where = target === "dev" ? "in the running dev session" : "in a process started for this command";
  const logs = (Array.isArray(result.logs) ? result.logs : []).filter(isJsonObject).map(entry => formatLogEntry(entry, root));
  switch (operation.kind) {
    case "invoke": {
      const outcome = fields(result.outcome);
      const head = outcome.ok === true
        ? `Invoked ${operation.handlerId} ${where}: ok in ${Math.round(Number(outcome.durationMs))} ms (trace ${String(outcome.correlationId)})`
        : `Invoked ${operation.handlerId} ${where}: failed (trace ${String(outcome.correlationId)})`;
      const value = outcome.value;
      return [head, ...value !== null && value !== undefined ? [`  returned ${JSON.stringify(value)}`] : [], ...logs].join("\n");
    }
    case "queue.send":
      return `Sent message ${String(result.messageId)} to queue ${String(result.queueId)} ${where}.${target === "dev" ? "" : " It is delivered when holqa dev runs."}`;
    case "storage.put": {
      const object = fields(result.object);
      return `Stored ${String(result.bucketId)}/${String(object.key)} (${String(object.size)} bytes, ${String(object.contentType ?? "no content type")}) ${where}.`;
    }
    case "cron.run": {
      const run = fields(result.run);
      return [`Ran schedule ${operation.scheduleId} ${where}: ${String(run.status)} (run ${String(run.runId)})`, ...logs].join("\n");
    }
    case "state":
      return describeState(result);
    case "doctor":
      return JSON.stringify(result);
  }
}

/**
 * Describes the local state for a terminal.
 *
 * @param result - The result of the `state` operation.
 * @returns The text.
 */
function describeState(result: Fields): string {
  /**
   * Reads a list of JSON objects from a result field.
   *
   * @param value - The field.
   * @returns The objects; other entries are skipped.
   */
  const list = (value: unknown): Fields[] => Array.isArray(value) ? (value as readonly unknown[]).filter(isJsonObject).map(fields) : [];
  const lines: string[] = [`Local state of "${String(result.application)}"`];
  for (const queue of list(result.queues)) {
    const counts = fields(queue.counts);
    lines.push(`  queue ${String(queue.id)}: ${Object.entries(counts).map(([state, count]) => `${String(count)} ${state}`).join(", ")}`);
    for (const message of list(queue.messages).filter(message => message.state !== "acknowledged").slice(-20)) {
      const error = message.lastError === undefined ? undefined : fields(message.lastError);
      lines.push(`    ${String(message.messageId)}  ${String(message.state).padEnd(13)}  attempts ${String(message.attempts)}${error === undefined ? "" : `  last error ${String(error.code)}: ${String(error.message)}`}`);
    }
  }
  for (const bucket of list(result.buckets)) {
    const objects = list(bucket.objects);
    lines.push(`  bucket ${String(bucket.id)}: ${objects.length} objects, ${list(bucket.events).length} events`);
    for (const object of objects.slice(0, 20))
      lines.push(`    ${String(object.key)}  ${String(object.size)} bytes  ${String(object.lastModified)}`);
    for (const event of list(bucket.events).slice(-10)) {
      const body = fields(event.event);
      const deliveries = list(event.deliveries).map(delivery => `${String(delivery.subscription)} ${String(delivery.state)} x${String(delivery.attempts)}`).join(", ");
      lines.push(`    event ${String(body.type)} ${String(fields(body.object).key)}  ${deliveries || "no subscribers"}`);
    }
  }
  for (const schedule of list(result.schedules)) {
    lines.push(`  schedule ${String(schedule.id)}: "${String(schedule.cron)}" ${String(schedule.timezone)}, next run ${String(schedule.nextRun ?? "never")}`);
    for (const run of list(schedule.runs).slice(0, 10))
      lines.push(`    ${String(run.scheduledTime)}  ${String(run.trigger).padEnd(6)}  ${String(run.status)}${run.code === undefined ? "" : `  ${String(run.code)}`}`);
  }
  return lines.join("\n");
}

/**
 * Reads diagnostics that crossed a process boundary as JSON.
 *
 * @param value - A JSON list of diagnostics.
 * @returns The diagnostics; malformed entries are skipped.
 */
function readDiagnostics(value: unknown): Diagnostic[] {
  return (Array.isArray(value) ? value as readonly unknown[] : []).flatMap((entry) => {
    const diagnostic = readDiagnostic(entry);
    return diagnostic === undefined ? [] : [diagnostic];
  });
}

/**
 * Parses a JSON option value.
 *
 * @param text - The value.
 * @returns The parsed value wrapped, or `null` when it is not JSON.
 */
function parseJson(text: string): { readonly value: JsonValue } | null {
  try {
    return { value: JSON.parse(text) as JsonValue };
  } catch {
    return null;
  }
}

/**
 * Parses a whole number within bounds.
 *
 * @param text - The value.
 * @param minimum - The smallest allowed value.
 * @param maximum - The largest allowed value.
 * @returns The number, or `undefined` when it is not a whole number within bounds.
 */
function integer(text: string, minimum: number, maximum: number): number | undefined {
  if (!/^\d+$/.test(text))
    return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

/**
 * Reports a usage problem.
 *
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param name - The command.
 * @param problems - What is wrong.
 * @returns The usage exit code.
 */
function usage(io: CliIo, json: boolean, name: string, problems: readonly string[]): number {
  reportDiagnostics(io, json, problems.map(problem => createDiagnostic({ code: diagnosticCodes.cliArgumentInvalid, severity: "error", message: `holqa ${name}: ${problem}`, hint: `Run "holqa --help" for the options of "holqa ${name}".` })));
  return exitCodes.usage;
}

/**
 * Reports that the CLI host cannot run a command.
 *
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param name - The command.
 * @returns The failure exit code.
 */
function unavailable(io: CliIo, json: boolean, name: string): number {
  reportDiagnostics(io, json, [createDiagnostic({ code: diagnosticCodes.localOperationFailed, severity: "error", message: `"holqa ${name}" is not available in this CLI host.` })]);
  return exitCodes.failure;
}