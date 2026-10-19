import type { JsonValue } from "@holqa/core";
import type {
  EmittedEvent,
  LogEntry
} from "@holqa/runtime-bun";

/** One finished invocation, read from the runtime's structured logs. */
export interface InvocationRecord {
  readonly handlerId: string;
  readonly invocationId: string;
  /** Shared by every invocation of one causal chain. */
  readonly correlationId: string;
  /** The invocation that sent the message or wrote the object that triggered this one. */
  readonly causationId?: string;
  /** The trigger kind, for example `queue.message`. */
  readonly trigger?: string;
  /** The resource whose trigger fired. */
  readonly resourceId?: string;
  readonly outcome: "ok" | "failed";
  /** The failure's diagnostic code. */
  readonly code?: string;
  /** The delivery attempt, for queue messages and object events. */
  readonly attempt?: number;
  /** Messages sent and objects changed by the invocation. */
  readonly emitted: readonly EmittedEvent[];
  readonly durationMs: number;
}

/**
 * Reads the invocation records from structured log entries: one per
 * `invocation completed` or `invocation failed` entry, in log order.
 *
 * @param entries - Log entries written by a runtime.
 * @returns One record per finished invocation.
 */
export function invocationRecords(entries: readonly LogEntry[]): InvocationRecord[] {
  return entries.flatMap((entry): InvocationRecord[] => {
    if (entry.message !== "invocation completed" && entry.message !== "invocation failed")
      return [];
    /**
     * Reads a string field of the entry.
     *
     * @param name - The field's name.
     * @returns The value, or `undefined`.
     */
    const text = (name: string): string | undefined => typeof entry[name] === "string" ? entry[name] : undefined;
    /**
     * Reads a number field of the entry.
     *
     * @param name - The field's name.
     * @returns The value, or `undefined`.
     */
    const number = (name: string): number | undefined => typeof entry[name] === "number" ? entry[name] : undefined;
    const causationId = text("causationId");
    const trigger = text("triggerKind");
    const resourceId = text("resourceId");
    const code = text("code");
    const attempt = number("attempt");
    const { emitted } = entry;
    return [Object.freeze({
      handlerId: text("handlerId") ?? "",
      invocationId: text("invocationId") ?? "",
      correlationId: text("correlationId") ?? "",
      ...causationId === undefined ? {} : { causationId },
      ...trigger === undefined ? {} : { trigger },
      ...resourceId === undefined ? {} : { resourceId },
      outcome: entry.message === "invocation completed" ? "ok" as const : "failed" as const,
      ...code === undefined ? {} : { code },
      ...attempt === undefined ? {} : { attempt },
      emitted: readEmitted(emitted),
      durationMs: number("durationMs") ?? 0
    })];
  });
}

/**
 * Reads the `emitted` field of a log entry.
 *
 * @param value - The field's value.
 * @returns The emitted events; malformed entries are skipped.
 */
function readEmitted(value: JsonValue | undefined): EmittedEvent[] {
  if (!Array.isArray(value))
    return [];
  return value.flatMap((item): EmittedEvent[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return [];
    const { type, resourceId, messageId, key } = item;
    if (typeof resourceId !== "string")
      return [];
    if (type === "queue.message" && typeof messageId === "string")
      return [{ type, resourceId, messageId }];
    if ((type === "object.created" || type === "object.deleted") && typeof key === "string")
      return [{ type, resourceId, key }];
    return [];
  });
}