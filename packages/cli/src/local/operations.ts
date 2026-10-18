import type {
  AppDescriptor,
  Diagnostic,
  JsonObject,
  JsonValue,
  ResourceDescriptor
} from "@holqa/core";
import type { LocalEnvironment } from "@holqa/local";
import type {
  InvocationOutcome,
  LogEntry,
  Runtime
} from "@holqa/runtime-bun";

import type { LocalOperation } from "@/local/protocol";

import {
  checkCapabilities,
  checkObjectKey,
  checkTriggerDelivery,
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf,
  failWith,
  HolqaError,
  messageEnvelopeFormat,
  nextCronTime,
  parseCronSchedule,
  prepareWirePayload
} from "@holqa/core";
import { manualTriggerMetadata } from "@holqa/local";

import { toJson } from "@/local/protocol";

/** The most bytes `holqa storage put` sends in one operation. */
export const maxPutBytes = 64 * 1024 * 1024;

/** Collects log entries so an operation can return the entries it caused. */
export class LogCapture {
  /** Every entry so far. */
  private readonly entries: LogEntry[] = [];

  /**
   * Records one entry.
   *
   * @param entry - A runtime log entry.
   */
  add(entry: LogEntry): void {
    this.entries.push(entry);
    // A long dev session must not keep every entry; operations only look at recent ones.
    if (this.entries.length > 10_000)
      this.entries.splice(0, this.entries.length - 5_000);
  }

  /**
   * Returns the entries that belong to one trace.
   *
   * @param correlationId - The trace's correlation identifier.
   * @returns The entries, in order, as JSON objects.
   */
  trace(correlationId: string): JsonObject[] {
    return this.entries.filter(({ correlationId: id }) => id === correlationId).map(entry => ({ ...entry }));
  }
}

/** What an operation can use. */
export interface OperationContext {
  readonly app: unknown;
  readonly descriptor: AppDescriptor;
  readonly local: LocalEnvironment;
  /** The runtime, when the operation needs one (invoking handlers, running schedules). */
  readonly runtime: Runtime | undefined;
  readonly logs: LogCapture;
  readonly createId: () => string;
  readonly now: () => number;
}

/**
 * Runs one local operation against a loaded application and its local
 * environment, and describes the result as JSON.
 *
 * @param context - The application, environment, runtime and logs.
 * @param operation - What to do.
 * @returns The JSON result.
 * @throws {HolqaError} With the diagnostics that explain a failed operation, for example `HOLQA_RESOURCE_NOT_FOUND`, `HOLQA_HANDLER_NOT_FOUND` or `HOLQA_INPUT_INVALID`.
 */
export async function executeOperation(context: OperationContext, operation: LocalOperation): Promise<JsonObject> {
  switch (operation.kind) {
    case "invoke":
      return invoke(context, operation.handlerId, operation.input, operation.attempt);
    case "queue.send": {
      const queue = resourceOf(context.descriptor, "queue", operation.queueId);
      const delaySeconds = operation.delaySeconds ?? 0;
      if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0)
        failWith(diagnosticCodes.operationInvalid, `The delay must be a whole number of seconds of at least 0, not ${String(delaySeconds)}.`);
      const payload = await prepareWirePayload(queue.schemas.message, operation.message as never, `message for queue "${queue.id}"`);
      const receipt = await context.local.binding.drivers.queue!(queue).send({ format: messageEnvelopeFormat, schemaVersion: queue.config.schemaVersion, payload }, delaySeconds === 0 ? {} : { delaySeconds });
      return { queueId: queue.id, messageId: receipt.messageId, schemaVersion: queue.config.schemaVersion, ...delaySeconds === 0 ? {} : { delaySeconds } };
    }
    case "storage.put": {
      const bucket = resourceOf(context.descriptor, "bucket", operation.bucketId);
      const problem = checkObjectKey(operation.key, `bucket "${bucket.id}" put`);
      if (problem !== undefined)
        throw new HolqaError(problem);
      const body = Buffer.from(operation.body, "base64");
      if (body.length > maxPutBytes)
        failWith(diagnosticCodes.operationInvalid, `The object is ${body.length} bytes; holqa storage put sends at most ${maxPutBytes}.`);
      const metadata = await context.local.binding.drivers.bucket!(bucket).put(operation.key, new Uint8Array(body), operation.contentType === undefined ? {} : { contentType: operation.contentType });
      return { bucketId: bucket.id, object: { ...metadata } };
    }
    case "cron.run": {
      const schedule = resourceOf(context.descriptor, "schedule", operation.scheduleId);
      const run = await context.local.scheduler.trigger(schedule.id);
      return { scheduleId: schedule.id, run: { ...run }, logs: context.logs.trace(run.runId) };
    }
    case "state":
      return state(context);
    case "doctor":
      return { checks: doctorChecks(context) };
  }
}

/**
 * Converts a failure into the response diagnostics.
 *
 * @param error - What an operation threw.
 * @returns Its diagnostics, or one `HOLQA_LOCAL_OPERATION_FAILED` describing an unexpected error.
 */
export function operationDiagnostics(error: unknown): Diagnostic[] {
  const carried = diagnosticsOf(error);
  if (carried.length > 0)
    return [...carried];
  return [createDiagnostic({ code: diagnosticCodes.localOperationFailed, severity: "error", message: `The operation failed: ${error instanceof Error ? error.message : String(error)}` })];
}

/**
 * Invokes a background handler once through the runtime.
 *
 * @param context - The operation context; must have a runtime.
 * @param handlerId - The handler to run.
 * @param input - Its untrusted input.
 * @param attempt - The delivery attempt it sees.
 * @returns The outcome and the log entries of its trace.
 * @throws {HolqaError} `HOLQA_HANDLER_NOT_FOUND`, or `HOLQA_OPERATION_INVALID` for HTTP handlers.
 */
async function invoke(context: OperationContext, handlerId: string, input: JsonValue | undefined, attempt: number | undefined): Promise<JsonObject> {
  const runtime = context.runtime;
  if (runtime === undefined)
    failWith(diagnosticCodes.runtimeNotRunning, "No runtime is available to invoke handlers.");
  const definition = runtime.handlers.find(handler => handler.id === handlerId);
  if (definition === undefined)
    failWith(diagnosticCodes.handlerNotFound, `The application "${context.descriptor.name}" has no handler "${handlerId}".`, `Handlers: ${runtime.handlers.map(handler => handler.id).join(", ") || "none"}.`);

  const metadata = manualTriggerMetadata(context.app, definition, { now: context.now(), createId: context.createId, ...attempt === undefined ? {} : { attempt } });
  const correlationId = context.createId();
  const outcome = await runtime.invoke({ handlerId, input, metadata, correlationId });
  return { handlerId, outcome: describeOutcome(outcome), logs: context.logs.trace(correlationId) };
}

/**
 * Describes an invocation outcome as JSON. Failures keep every diagnostic,
 * because the developer running the command owns the application.
 *
 * @param outcome - The runtime's outcome.
 * @returns The JSON description.
 */
function describeOutcome(outcome: InvocationOutcome): JsonObject {
  const base: JsonObject = { ok: outcome.ok, handlerId: outcome.handlerId, invocationId: outcome.invocationId, correlationId: outcome.correlationId, durationMs: outcome.durationMs, emitted: outcome.emitted.map(event => ({ ...event })) };
  if (outcome.ok)
    return { ...base, value: toJson(outcome.value) };
  const { failure } = outcome;
  return { ...base, failure: { code: failure.code, message: failure.message, diagnostics: toJson(failure.diagnostics), ...failure.issues.length === 0 ? {} : { issues: toJson(failure.issues) } } };
}

/**
 * Finds a declared resource of one kind.
 *
 * @param descriptor - The application.
 * @param kind - The kind the resource must have.
 * @param resourceId - The identifier given on the command line.
 * @returns The declared resource.
 * @throws {HolqaError} `HOLQA_RESOURCE_NOT_FOUND`, listing the resources of that kind.
 */
function resourceOf<Kind extends ResourceDescriptor["kind"]>(descriptor: AppDescriptor, kind: Kind, resourceId: string): ResourceDescriptor & { readonly kind: Kind } {
  const candidates = descriptor.resources.filter((resource): resource is ResourceDescriptor & { readonly kind: Kind } => resource.kind === kind);
  const found = candidates.find(resource => resource.id === resourceId);
  if (found === undefined)
    failWith(diagnosticCodes.resourceNotFound, `The application "${descriptor.name}" declares no ${kind} "${resourceId}".`, `Declared: ${candidates.map(resource => resource.id).join(", ") || "none"}.`);
  return found;
}

/**
 * Describes the local state of every queue, bucket and schedule.
 *
 * @param context - The operation context.
 * @returns Queues with their messages, buckets with their objects and events, schedules with their runs and next run.
 */
function state(context: OperationContext): JsonObject {
  const { descriptor, local } = context;
  const queues: JsonObject[] = [];
  const buckets: JsonObject[] = [];
  const schedules: JsonObject[] = [];
  for (const resource of descriptor.resources) {
    if (resource.kind === "queue") {
      const messages = local.queues.messages(resource.id);
      const counts: Record<string, number> = { "ready": 0, "delayed": 0, "in-flight": 0, "acknowledged": 0, "dead-lettered": 0 };
      for (const message of messages)
        counts[message.state] = (counts[message.state] ?? 0) + 1;
      queues.push({ id: resource.id, counts, messages: toJson(messages) });
    } else if (resource.kind === "bucket") {
      buckets.push({ id: resource.id, objects: toJson(local.storage.objects(resource.id)), events: toJson(local.storage.events(resource.id)) });
    } else if (resource.kind === "schedule") {
      const parsed = parseCronSchedule(resource.config.cron, resource.config.timezone);
      const next = parsed.ok ? nextCronTime(parsed.value, context.now()) : undefined;
      schedules.push({ id: resource.id, cron: resource.config.cron, timezone: resource.config.timezone, ...next === undefined ? {} : { nextRun: new Date(next).toISOString() }, runs: toJson(local.scheduler.runs(resource.id, 20)) });
    }
  }
  return { application: descriptor.name, queues, buckets, schedules };
}

/** One result of `holqa doctor`. */
export interface DoctorCheck extends JsonObject {
  readonly name: string;
  readonly status: "ok" | "warning" | "error";
  readonly message: string;
  /** The diagnostics behind a warning or error. */
  readonly diagnostics?: JsonValue;
}

/**
 * Checks what only a loaded application can tell: whether the local binding
 * can provide every resource and deliver every trigger. Configuration is
 * checked when the environment is created, before this runs.
 *
 * @param context - The operation context; its environment uses a scratch directory.
 * @returns The `configuration` and `capabilities` checks.
 */
function doctorChecks(context: OperationContext): DoctorCheck[] {
  const { descriptor, local } = context;
  const definitions = context.runtime?.handlers ?? [];
  const problems = [
    ...descriptor.resources.flatMap(resource => checkCapabilities(resource, local.binding.capabilities, local.binding.name)),
    ...checkTriggerDelivery(descriptor, definitions, local.binding)
  ];
  return [
    { name: "configuration", status: "ok", message: `All ${descriptor.config.length} configuration entries are set or have defaults.` },
    problems.length === 0
      ? { name: "capabilities", status: "ok", message: `The local binding provides all ${descriptor.resources.length} resources and delivers every trigger of the ${definitions.length} handlers.` }
      : { name: "capabilities", status: "error", message: "The local binding cannot run the application as declared.", diagnostics: toJson(problems) }
  ];
}