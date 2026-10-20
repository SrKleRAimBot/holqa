import type {
  HandlerDescriptor,
  InvocationContext,
  JsonObject,
  JsonValue,
  Redactor
} from "@holqa/core";

import type { InvocationRecord } from "@/app/invocation-records";

import {
  createDiagnostic,
  descriptorKey,
  diagnosticCodes,
  getHandlerDescriptor,
  HolqaError,
  isJsonValue
} from "@holqa/core";

/** The format identifier of a {@link Recording}. */
export const recordingFormat = "holqa.recording/1";

/** One recorded invocation: what a handler received, so it can be replayed. */
export interface RecordedInvocation {
  readonly invocationId: string;
  readonly handlerId: string;
  /** The trigger kind, for example `queue.message`. */
  readonly triggerKind: string;
  /**
   * The handler's input as JSON data, before validation: a queue message's
   * payload, an object event, a schedule tick. Absent when the input has no
   * JSON form (HTTP requests), which makes the invocation not replayable.
   */
  readonly input?: JsonValue;
  /** The trusted trigger metadata the handler received (attempt, message identifier, scheduled time). */
  readonly metadata: JsonObject;
  /** The invocation's event lineage. */
  readonly lineage: {
    readonly correlationId: string;
    readonly causationId?: string;
    readonly rootId: string;
    readonly depth: number;
  };
  /** Whether {@link RecordedInvocation.input} holds the complete input, so the invocation can be replayed. */
  readonly replayable: boolean;
}

/**
 * Recorded invocations of a test application, as JSON data that can be
 * written to a file and replayed later, in another test or process.
 */
export interface Recording {
  readonly format: typeof recordingFormat;
  /** The application's name. */
  readonly application: string;
  /** Whether sensitive fields and secret values were redacted (which can change what a replay does). */
  readonly sanitized: boolean;
  readonly invocations: readonly RecordedInvocation[];
}

/** One step of a causal chain, as {@link chainSteps} lists them. */
export interface ChainStep {
  /** The step's position in causal order, from 0. */
  readonly index: number;
  /** The invocation, as read from the logs. */
  readonly record: InvocationRecord;
  /** What the handler received, when it was recorded. */
  readonly input?: JsonValue;
  /** The step that caused this one, by index; absent for the root. */
  readonly causedBy?: number;
}

/**
 * Converts a value into JSON data when it has an exact JSON form.
 *
 * @param value - Any value.
 * @returns A deep copy, or `undefined` when the value is not JSON data.
 */
function jsonCopy(value: unknown): JsonValue | undefined {
  if (!isJsonValue(value))
    return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * Records the input of every invocation of the handlers it instruments, in
 * the order handlers start. Inputs are copied when the handler starts, so a
 * handler that mutates its input does not change the recording.
 */
export class InvocationRecorder {
  /** Recorded invocations, in start order. */
  private readonly recorded: RecordedInvocation[] = [];

  /**
   * Wraps a handler registration so that its invocations are recorded. Values
   * that are not handler registrations are returned unchanged, so the runtime
   * still reports them.
   *
   * @param registration - A handler module's export.
   * @returns A registration whose `invoke` records its input first.
   */
  instrument(registration: unknown): unknown {
    const descriptor = getHandlerDescriptor(registration);
    if (descriptor === undefined)
      return registration;
    const { id: handlerId, trigger } = descriptor.definition;
    const original = descriptor.invoke as (input: unknown, context: InvocationContext<object>) => Promise<unknown>;
    /**
     * Records the invocation, then runs the handler.
     *
     * @param input - The invocation's input.
     * @param context - The invocation's context.
     * @returns What the handler returns.
     */
    const invoke = async (input: unknown, context: InvocationContext<object>): Promise<unknown> => {
      const copy = jsonCopy(input);
      const metadata = jsonCopy(context.metadata);
      const lineage = context.lineage;
      this.recorded.push({
        invocationId: context.invocationId,
        handlerId,
        triggerKind: trigger.kind,
        ...copy === undefined ? {} : { input: copy },
        metadata: typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? metadata as JsonObject : {},
        lineage: {
          correlationId: lineage?.correlationId ?? context.correlationId ?? context.invocationId,
          ...lineage?.causationId === undefined ? {} : { causationId: lineage.causationId },
          rootId: lineage?.rootId ?? context.invocationId,
          depth: lineage?.depth ?? 0
        },
        replayable: copy !== undefined || input === undefined
      });
      return original(input, context);
    };
    return Object.freeze({ [descriptorKey]: Object.freeze({ ...descriptor, invoke } as HandlerDescriptor) });
  }

  /**
   * Returns the recorded invocations.
   *
   * @returns The invocations, in start order.
   */
  invocations(): readonly RecordedInvocation[] {
    return this.recorded;
  }
}

/**
 * Builds a recording from recorded invocations, optionally redacting inputs
 * and metadata with the same rules as logs: fields with sensitive names and
 * known secret values are replaced. Redaction can change what a replay does;
 * replay unsanitized recordings in the same test when exact inputs matter.
 *
 * @param application - The application's name.
 * @param invocations - The recorded invocations.
 * @param redactor - Redacts sensitive data; `undefined` keeps inputs as recorded.
 * @returns A frozen `holqa.recording/1` document.
 */
export function createRecording(application: string, invocations: readonly RecordedInvocation[], redactor: Redactor | undefined): Recording {
  return Object.freeze({
    format: recordingFormat,
    application,
    sanitized: redactor !== undefined,
    invocations: Object.freeze(invocations.map(entry => redactor === undefined
      ? entry
      : Object.freeze({ ...entry, ...entry.input === undefined ? {} : { input: redactor.json(entry.input) }, metadata: redactor.object(entry.metadata) })))
  });
}

/**
 * Builds a `HOLQA_OPERATION_INVALID` error about a recording.
 *
 * @param message - What is wrong.
 * @returns The error.
 */
function invalid(message: string): HolqaError {
  return new HolqaError(createDiagnostic({ code: diagnosticCodes.operationInvalid, severity: "error", message, hint: "Pass a recording returned by TestApp.recording(), or one of its invocations." }));
}

/**
 * Reads recorded invocations from untrusted data, such as a recording read
 * from a file: a recording, one recorded invocation or a list of them.
 *
 * @param source - The candidate.
 * @returns The invocations, and whether the source was a whole recording.
 * @throws {HolqaError} `HOLQA_OPERATION_INVALID` when the data is malformed or of another format.
 */
export function readRecordedInvocations(source: unknown): { readonly invocations: readonly RecordedInvocation[]; readonly whole: boolean } {
  const candidate = source as { readonly format?: unknown; readonly invocations?: unknown } | null;
  const whole = typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) && "format" in candidate;
  if (whole && candidate.format !== recordingFormat)
    throw invalid(`The recording has format ${JSON.stringify(candidate.format)}; this version reads ${recordingFormat}.`);
  const entries: unknown[] = whole ? Array.isArray(candidate.invocations) ? candidate.invocations : [] : Array.isArray(source) ? source : [source];
  if (whole && !Array.isArray(candidate.invocations))
    throw invalid("The recording has no list of invocations.");
  const invocations = entries.map((entry, index): RecordedInvocation => {
    const value = entry as Partial<Record<keyof RecordedInvocation, unknown>> | null;
    const lineage = (value?.lineage ?? undefined) as Partial<Record<"correlationId" | "causationId" | "rootId" | "depth", unknown>> | undefined;
    if (typeof value !== "object" || value === null || typeof value.invocationId !== "string" || typeof value.handlerId !== "string" || typeof value.triggerKind !== "string" || typeof value.replayable !== "boolean"
      || typeof value.metadata !== "object" || value.metadata === null || Array.isArray(value.metadata) || !isJsonValue(value.metadata)
      || (value.input !== undefined && !isJsonValue(value.input))
      || typeof lineage !== "object" || lineage === null || typeof lineage.correlationId !== "string" || typeof lineage.rootId !== "string" || typeof lineage.depth !== "number" || (lineage.causationId !== undefined && typeof lineage.causationId !== "string"))
      throw invalid(`Recorded invocation ${index} is malformed.`);
    return value as RecordedInvocation;
  });
  return { invocations, whole };
}

/**
 * Lists the invocations of one root operation in causal order, depth first:
 * the root, then each invocation it caused followed by everything that one
 * caused, in the order they finished. Each step carries its recorded input.
 *
 * @param records - Finished invocations, read from the logs.
 * @param recorded - Recorded inputs.
 * @param rootId - The root operation's identifier.
 * @returns The steps; empty when no invocation descends from the root.
 */
export function chainSteps(records: readonly InvocationRecord[], recorded: readonly RecordedInvocation[], rootId: string): ChainStep[] {
  const members = records.filter(record => record.rootId === rootId);
  const inputs = new Map(recorded.map(entry => [entry.invocationId, entry.input]));
  const ids = new Set(members.map(record => record.invocationId));
  const children = new Map<string | undefined, InvocationRecord[]>();
  for (const record of members) {
    // A step whose cause is not part of the operation (for example a redriven message) starts a branch at the top.
    const parent = record.causationId !== undefined && ids.has(record.causationId) ? record.causationId : undefined;
    children.set(parent, [...children.get(parent) ?? [], record]);
  }
  const steps: ChainStep[] = [];
  /**
   * Appends a step and, depth first, the steps it caused.
   *
   * @param record - The invocation to append.
   * @param causedBy - The index of its cause.
   */
  const visit = (record: InvocationRecord, causedBy: number | undefined): void => {
    const index = steps.length;
    const input = inputs.get(record.invocationId);
    steps.push(Object.freeze({ index, record, ...input === undefined ? {} : { input }, ...causedBy === undefined ? {} : { causedBy } }));
    for (const child of children.get(record.invocationId) ?? [])
      visit(child, index);
  };
  for (const top of children.get(undefined) ?? [])
    visit(top, undefined);
  return steps;
}