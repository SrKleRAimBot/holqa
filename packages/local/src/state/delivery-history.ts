import type {
  DeliveryTrace,
  ObjectEventType
} from "@holqa/core";

import type {
  DeliveryError,
  DeliveryState
} from "@/state/lease-store";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { stateFileName } from "@/state/database";

/** One stored delivery of a queue message or object event, as `holqa events inspect` shows it. */
export interface DeliveryRecord {
  /** `queue.message` for a queue message; `object.event` for one subscription's copy of an object event. */
  readonly kind: "queue.message" | "object.event";
  /** The queue or bucket. */
  readonly resourceId: string;
  /** For object events: the handler whose copy this is. */
  readonly subscription?: string;
  readonly state: DeliveryState;
  /** Leases so far, including expired ones. */
  readonly attempts: number;
  /** When it was sent or the change happened (ISO 8601). */
  readonly sentAt: string;
  /** When it is or was due next (ISO 8601). */
  readonly visibleAt: string;
  readonly updatedAt: string;
  readonly lastError?: DeliveryError;
  readonly trace?: DeliveryTrace;
}

/** The object change an object event describes. */
export interface ObjectEventSummary {
  readonly bucket: string;
  readonly type: ObjectEventType;
  readonly key: string;
  /** ISO 8601. */
  readonly time: string;
}

/** Everything the local state knows about one queue message or object event. */
export interface DeliveryHistory {
  readonly id: string;
  /** One record per channel that holds it: one for a message, one per subscription for an object event. */
  readonly deliveries: readonly DeliveryRecord[];
  /** Present when the identifier is an object event's. */
  readonly objectEvent?: ObjectEventSummary;
}

/** A row of the `deliveries` table, as read without assuming the newest columns exist. */
interface HistoryRow {
  readonly channel: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly visible_at: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly last_invocation_id: string | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly root_id?: string | null;
  readonly depth?: number | null;
  readonly traceparent?: string | null;
}

/**
 * Reads what the local state of a directory records about one queue message
 * or object event: every channel's delivery state, attempts, last error and
 * lineage, and the object change for an object event. Opens the state read-only
 * and changes nothing, so it is safe while a dev session runs.
 *
 * @param directory - The local state directory.
 * @param id - A message identifier or object event identifier.
 * @returns The history, or `undefined` when the directory has no state or nothing has that identifier.
 */
export function readDeliveryHistory(directory: string, id: string): DeliveryHistory | undefined {
  const file = join(directory, stateFileName);
  if (!existsSync(file))
    return undefined;
  const database = new Database(file, { readonly: true, strict: true });
  try {
    const rows = database.query<HistoryRow, [string]>("SELECT * FROM deliveries WHERE delivery_id = ? ORDER BY seq").all(id);
    const event = database.query<{ bucket: string; type: ObjectEventType; key: string; time: number }, [string]>("SELECT bucket, type, key, time FROM object_events WHERE id = ?").get(id);
    if (rows.length === 0 && event === null)
      return undefined;
    return Object.freeze({
      id,
      deliveries: rows.map(toRecord),
      ...event === null ? {} : { objectEvent: Object.freeze({ bucket: event.bucket, type: event.type, key: event.key, time: new Date(event.time).toISOString() }) }
    });
  } finally {
    database.close();
  }
}

/**
 * Converts one row into a delivery record.
 *
 * @param row - The stored delivery.
 * @returns Its inspection form.
 */
function toRecord(row: HistoryRow): DeliveryRecord {
  const [prefix, resourceId = "", subscription] = row.channel.split(":");
  const rootId = row.root_id;
  const trace: DeliveryTrace | undefined = row.correlation_id === null
    ? undefined
    : {
      correlationId: row.correlation_id,
      ...row.causation_id === null ? {} : { causationId: row.causation_id },
      ...typeof rootId === "string" && typeof row.depth === "number" ? { rootId, depth: row.depth } : {},
      ...typeof row.traceparent === "string" ? { traceparent: row.traceparent } : {}
    };
  return Object.freeze({
    kind: prefix === "queue" ? "queue.message" : "object.event",
    resourceId,
    ...subscription === undefined ? {} : { subscription },
    state: row.state,
    attempts: row.attempts,
    sentAt: new Date(row.created_at).toISOString(),
    visibleAt: new Date(row.visible_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...row.last_error_code === null ? {} : { lastError: { code: row.last_error_code, message: row.last_error_message ?? "", ...row.last_invocation_id === null ? {} : { invocationId: row.last_invocation_id } } },
    ...trace === undefined ? {} : { trace }
  });
}