import type {
  Diagnostic,
  JsonObject,
  JsonValue
} from "@holqa/core";

import type {
  SwapOutcome,
  SwapRequest,
  SwapVersion
} from "@/local/hot-swap";

import { isJsonValue } from "@holqa/core";

import { readDiagnostic } from "@/analysis/report";

// The local operations the CLI performs against an application, and the
// messages the CLI exchanges with the generation process that runs it. Every
// message is a JSON text, so that nothing the application prints or returns
// can be mistaken for a message, and every received message is checked before
// use: the generation process runs application code.

/** One operation on a locally running application. */
export type LocalOperation
  = | { readonly kind: "invoke"; readonly handlerId: string; readonly input?: JsonValue; readonly attempt?: number }
    | { readonly kind: "queue.send"; readonly queueId: string; readonly message: JsonValue; readonly delaySeconds?: number }
    | { readonly kind: "queue.redrive"; readonly queueId: string; readonly messageId?: string; readonly limit?: number; readonly dryRun?: boolean; readonly newOperation?: boolean }
    | { readonly kind: "storage.put"; readonly bucketId: string; readonly key: string; readonly contentType?: string; readonly body: string }
    | { readonly kind: "cron.run"; readonly scheduleId: string }
    | { readonly kind: "state" }
    | { readonly kind: "doctor" }
    | { readonly kind: "handlers" };

/** What an operation produced: a JSON result, or the diagnostics that explain why it failed. */
export type OperationResponse
  = | { readonly ok: true; readonly result: JsonObject }
    | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** How the generation process runs: `serve` for `holqa dev`, `once` for one operation without a dev session. */
export type GenerationMode = "serve" | "once";

/** What the generation process is asked to run, passed as its first argument. */
export interface GenerationRequest {
  readonly mode: GenerationMode;
  /** The application root. */
  readonly root: string;
  /** The `holqa build --manifest` output to load, absolute. */
  readonly buildDir: string;
  /** The local state directory, absolute. */
  readonly stateDir: string;
  /** The origin requests are addressed to, for example `http://127.0.0.1:3000`; signed URLs point here. */
  readonly publicOrigin: string;
  /** The generation number, for logs. */
  readonly generation: number;
  /** Queues whose message contract changed: messages already waiting in them are checked against the new contract and reported. */
  readonly revalidateQueues?: readonly string[];
}

/** Messages from the generation process to the CLI. */
export type GenerationMessage
  = | { readonly type: "prepared" }
    | { readonly type: "ready"; readonly port: number }
    | { readonly type: "waiting" }
    | { readonly type: "result"; readonly id: string; readonly response: OperationResponse }
    | { readonly type: "log"; readonly entry: JsonObject }
    | { readonly type: "failed"; readonly diagnostics: readonly Diagnostic[] }
    | { readonly type: "swap-result"; readonly id: string; readonly outcome: SwapOutcome }
    | { readonly type: "stopped" };

/** Messages from the CLI to the generation process. */
export type ControlMessage
  = | { readonly type: "activate" }
    | { readonly type: "operation"; readonly id: string; readonly operation: LocalOperation }
    | { readonly type: "swap"; readonly id: string; readonly swap: SwapRequest }
    | { readonly type: "stop" };

/**
 * The fields the readers look at, all unchecked. Reading untrusted JSON
 * through this view keeps every value `unknown` until it is checked.
 */
interface RawFields {
  readonly type?: unknown;
  readonly port?: unknown;
  readonly id?: unknown;
  readonly response?: unknown;
  readonly entry?: unknown;
  readonly diagnostics?: unknown;
  readonly operation?: unknown;
  readonly kind?: unknown;
  readonly contentType?: unknown;
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly message?: unknown;
  readonly level?: unknown;
  readonly dryRun?: unknown;
  readonly newOperation?: unknown;
  readonly messageId?: unknown;
  readonly outcome?: unknown;
  readonly swap?: unknown;
}

/**
 * Reads a message the generation process sent, without trusting it.
 *
 * @param text - The received JSON text.
 * @returns The message, or `undefined` when it is malformed.
 */
export function readGenerationMessage(text: unknown): GenerationMessage | undefined {
  const value = parseObject(text) as RawFields | undefined;
  if (value === undefined)
    return undefined;
  switch (value.type) {
    case "prepared":
    case "waiting":
    case "stopped":
      return { type: value.type };
    case "ready": {
      const port = value.port;
      return typeof port === "number" && Number.isSafeInteger(port) && port > 0 && port < 65_536 ? { type: "ready", port } : undefined;
    }
    case "result": {
      const response = readOperationResponse(value.response);
      return typeof value.id === "string" && response !== undefined ? { type: "result", id: value.id, response } : undefined;
    }
    case "log": {
      const entry = value.entry;
      return isJsonObject(entry) && typeof (entry as RawFields).message === "string" && typeof (entry as RawFields).level === "string" ? { type: "log", entry } : undefined;
    }
    case "failed": {
      const diagnostics = readDiagnostics(value.diagnostics);
      return diagnostics === undefined ? undefined : { type: "failed", diagnostics };
    }
    case "swap-result": {
      const outcome = readSwapOutcome(value.outcome);
      return typeof value.id === "string" && outcome !== undefined ? { type: "swap-result", id: value.id, outcome } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Reads a control message the CLI sent.
 *
 * @param text - The received JSON text.
 * @returns The message, or `undefined` when it is malformed.
 */
export function readControlMessage(text: unknown): ControlMessage | undefined {
  const value = parseObject(text) as RawFields | undefined;
  if (value === undefined)
    return undefined;
  if (value.type === "activate" || value.type === "stop")
    return { type: value.type };
  if (value.type === "operation" && typeof value.id === "string") {
    const operation = readOperation(value.operation);
    return operation === undefined ? undefined : { type: "operation", id: value.id, operation };
  }
  if (value.type === "swap" && typeof value.id === "string") {
    if (!isJsonObject(value.swap))
      return undefined;
    const { modules, shared } = value.swap as { readonly modules?: unknown; readonly shared?: unknown };
    if (!isStringList(modules) || !isStringList(shared))
      return undefined;
    return { type: "swap", id: value.id, swap: { modules, shared } };
  }
  return undefined;
}

/**
 * Reports whether a value is a list of strings.
 *
 * @param value - The candidate.
 * @returns `true` for arrays whose entries are all strings.
 */
function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

/**
 * Reads handler versions, checking every field.
 *
 * @param value - The candidate list.
 * @returns The versions, or `undefined` when any is malformed.
 */
export function readSwapVersions(value: unknown): SwapVersion[] | undefined {
  if (!Array.isArray(value))
    return undefined;
  const versions: SwapVersion[] = [];
  /**
   * Reports whether a value is a non-negative safe integer.
   *
   * @param candidate - The value.
   * @returns `true` for counts and version numbers.
   */
  const count = (candidate: unknown): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
  for (const entry of value as readonly unknown[]) {
    const candidate = entry as { readonly handlerId?: unknown; readonly version?: unknown; readonly active?: unknown; readonly retiring?: unknown } | null;
    if (typeof candidate !== "object" || candidate === null || typeof candidate.handlerId !== "string" || !count(candidate.version) || !count(candidate.active) || !Array.isArray(candidate.retiring))
      return undefined;
    const retiring: Array<{ readonly version: number; readonly active: number }> = [];
    for (const old of candidate.retiring as readonly unknown[]) {
      const record = old as { readonly version?: unknown; readonly active?: unknown } | null;
      if (typeof record !== "object" || record === null || !count(record.version) || !count(record.active))
        return undefined;
      retiring.push({ version: record.version, active: record.active });
    }
    versions.push({ handlerId: candidate.handlerId, version: candidate.version, active: candidate.active, retiring });
  }
  return versions;
}

/**
 * Reads the outcome of a replacement, checking every field.
 *
 * @param candidate - A parsed JSON value.
 * @returns The outcome, or `undefined` when it is malformed.
 */
function readSwapOutcome(candidate: unknown): SwapOutcome | undefined {
  if (!isJsonObject(candidate))
    return undefined;
  const value = candidate as { readonly ok?: unknown; readonly version?: unknown; readonly handlers?: unknown; readonly durationMs?: unknown; readonly versions?: unknown; readonly restart?: unknown; readonly reason?: unknown; readonly diagnostics?: unknown };
  if (value.ok === true) {
    const versions = readSwapVersions(value.versions);
    if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || !isStringList(value.handlers) || typeof value.durationMs !== "number" || versions === undefined)
      return undefined;
    return { ok: true, version: value.version, handlers: value.handlers, durationMs: value.durationMs, versions };
  }
  const diagnostics = readDiagnostics(value.diagnostics);
  if (value.ok !== false || typeof value.restart !== "boolean" || diagnostics === undefined || (value.reason !== undefined && value.reason !== "side-effects" && value.reason !== "replacement-rejected"))
    return undefined;
  return { ok: false, restart: value.restart, ...value.reason === undefined ? {} : { reason: value.reason }, diagnostics };
}

/**
 * Reads an operation, checking every field.
 *
 * @param candidate - A parsed JSON value.
 * @returns The operation, or `undefined` when it is malformed.
 */
export function readOperation(candidate: unknown): LocalOperation | undefined {
  if (!isJsonObject(candidate))
    return undefined;
  const value = candidate as RawFields & JsonObject;
  /**
   * Reads a string field.
   *
   * @param name - The field's name.
   * @returns The value, or `undefined` when it is not a string.
   */
  const text = (name: string): string | undefined => typeof value[name] === "string" ? value[name] : undefined;
  /**
   * Reads an optional whole-number field.
   *
   * @param name - The field's name.
   * @returns The value, `undefined` when absent, or `null` when it is not a safe integer.
   */
  const integer = (name: string): number | undefined | null => {
    const field = value[name];
    return field === undefined ? undefined : typeof field === "number" && Number.isSafeInteger(field) ? field : null;
  };
  switch (value.kind) {
    case "invoke": {
      const handlerId = text("handlerId");
      const attempt = integer("attempt");
      if (handlerId === undefined || attempt === null)
        return undefined;
      const { input } = candidate;
      return { kind: "invoke", handlerId, ...input === undefined ? {} : { input }, ...attempt === undefined ? {} : { attempt } };
    }
    case "queue.send": {
      const queueId = text("queueId");
      const delaySeconds = integer("delaySeconds");
      const { message } = candidate;
      if (queueId === undefined || message === undefined || delaySeconds === null)
        return undefined;
      return { kind: "queue.send", queueId, message, ...delaySeconds === undefined ? {} : { delaySeconds } };
    }
    case "queue.redrive": {
      const queueId = text("queueId");
      const messageId = text("messageId");
      const limit = integer("limit");
      const flags = [value.dryRun, value.newOperation];
      if (queueId === undefined || (value.messageId !== undefined && messageId === undefined) || limit === null || (limit !== undefined && limit < 1) || flags.some(flag => flag !== undefined && typeof flag !== "boolean"))
        return undefined;
      return { kind: "queue.redrive", queueId, ...messageId === undefined ? {} : { messageId }, ...limit === undefined ? {} : { limit }, ...value.dryRun === true ? { dryRun: true } : {}, ...value.newOperation === true ? { newOperation: true } : {} };
    }
    case "storage.put": {
      const bucketId = text("bucketId");
      const key = text("key");
      const body = text("body");
      const contentType = text("contentType");
      if (bucketId === undefined || key === undefined || body === undefined || (value.contentType !== undefined && contentType === undefined))
        return undefined;
      return { kind: "storage.put", bucketId, key, body, ...contentType === undefined ? {} : { contentType } };
    }
    case "cron.run": {
      const scheduleId = text("scheduleId");
      return scheduleId === undefined ? undefined : { kind: "cron.run", scheduleId };
    }
    case "state":
    case "doctor":
    case "handlers":
      return { kind: value.kind };
    default:
      return undefined;
  }
}

/**
 * Reads an operation response.
 *
 * @param candidate - A parsed JSON value.
 * @returns The response, or `undefined` when it is malformed.
 */
export function readOperationResponse(candidate: unknown): OperationResponse | undefined {
  if (!isJsonObject(candidate))
    return undefined;
  const value = candidate as RawFields;
  if (value.ok === true && isJsonObject(value.result))
    return { ok: true, result: value.result };
  if (value.ok === false) {
    const diagnostics = readDiagnostics(value.diagnostics);
    return diagnostics === undefined || diagnostics.length === 0 ? undefined : { ok: false, diagnostics };
  }
  return undefined;
}

/**
 * Converts any value into JSON data: values without a JSON form become their
 * string description, so a handler's return value can always be reported.
 *
 * @param value - Any value.
 * @returns A JSON value.
 */
export function toJson(value: unknown): JsonValue {
  if (value === undefined)
    return null;
  try {
    const text = JSON.stringify(value);
    if (text === undefined)
      return String(value);
    const parsed: unknown = JSON.parse(text);
    return isJsonValue(parsed) ? parsed : String(value);
  } catch {
    // Cyclic or otherwise unserializable values are described instead.
    return String(value);
  }
}

/**
 * Reports whether a value is a JSON object (not an array).
 *
 * @param value - Any value.
 * @returns `true` for plain JSON objects.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);
}

/**
 * Parses a JSON text that must hold an object.
 *
 * @param text - The candidate text.
 * @returns The object, or `undefined`.
 */
function parseObject(text: unknown): JsonObject | undefined {
  if (typeof text !== "string")
    return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a list of diagnostics with registered codes.
 *
 * @param value - The candidate list.
 * @returns The diagnostics, or `undefined` when any is malformed.
 */
function readDiagnostics(value: unknown): Diagnostic[] | undefined {
  if (!Array.isArray(value))
    return undefined;
  const diagnostics: Diagnostic[] = [];
  for (const entry of value as readonly unknown[]) {
    const diagnostic = readDiagnostic(entry);
    if (diagnostic === undefined)
      return undefined;
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}