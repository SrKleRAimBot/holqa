import {
  existsSync,
  mkdirSync
} from "node:fs";
import { join } from "node:path";
import {
  diagnosticCodes,
  failWith
} from "@holqa/core";

import { Database } from "bun:sqlite";

/**
 * The state format this version of the local drivers reads and writes.
 * Format 2 adds the sender's trace to deliveries; format 3 adds the event
 * lineage (root operation and depth) to deliveries, per-operation budgets
 * and idempotency keys. Older directories are upgraded in place when they
 * are opened; deliveries written before format 3 start a new lineage.
 */
export const stateVersion = 3;

/** The file the state lives in, inside the state directory. */
export const stateFileName = "state.sqlite";

/**
 * The tables of state version 3. Every time is epoch milliseconds of the
 * environment's clock.
 *
 * - `deliveries`: leased deliveries of queue messages and object events. A
 *   row is due when its `state` is `ready` or `leased` and `visible_at` has
 *   passed; a leased row's `visible_at` is the end of its lease.
 *   `correlation_id`, `causation_id`, `root_id` and `depth` record the
 *   sender's trace and lineage.
 * - `operation_budgets`: events published per root operation, for
 *   `maxEventsPerOperation`; updated in transactions, so every process that
 *   shares the directory sees one count.
 * - `idempotency_keys`: claimed and completed idempotency keys by scope.
 * - `objects`: object metadata; the bytes live in files named by `blob`.
 * - `object_events`: every object event, for inspection.
 * - `event_subscriptions`: which handlers receive which events of a bucket.
 * - `schedule_runs`: every scheduled run and its result.
 * - `meta`: environment settings such as the signed URL key.
 */
const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'leased', 'acknowledged', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  visible_at INTEGER NOT NULL,
  lease_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  last_invocation_id TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  root_id TEXT,
  depth INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (channel, state, visible_at);
CREATE INDEX IF NOT EXISTS deliveries_identity ON deliveries (channel, delivery_id);
CREATE TABLE IF NOT EXISTS objects (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT,
  etag TEXT NOT NULL,
  last_modified INTEGER NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (bucket, key)
) STRICT;
CREATE TABLE IF NOT EXISTS object_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  bucket TEXT NOT NULL,
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  time INTEGER NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS event_subscriptions (
  bucket TEXT NOT NULL,
  subscription TEXT NOT NULL,
  types TEXT NOT NULL,
  prefix TEXT NOT NULL,
  PRIMARY KEY (bucket, subscription)
) STRICT;
CREATE TABLE IF NOT EXISTS operation_budgets (
  root_id TEXT PRIMARY KEY,
  used INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held', 'completed')),
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (scope, key)
) STRICT;
CREATE TABLE IF NOT EXISTS schedule_runs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  schedule TEXT NOT NULL,
  scheduled_time INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped', 'missed')),
  started_at INTEGER,
  finished_at INTEGER,
  code TEXT,
  message TEXT,
  invocation_id TEXT
) STRICT;
`;

/**
 * Reads the format of a state directory without creating, upgrading or
 * otherwise changing it, for diagnostics such as `holqa doctor`.
 *
 * @param directory - The directory whose `state.sqlite` is read.
 * @returns The format number, or `undefined` when the directory holds no state yet.
 * @throws {Error} When the state file exists but cannot be read.
 */
export function readStateFormat(directory: string): number | undefined {
  const file = join(directory, stateFileName);
  if (!existsSync(file))
    return undefined;
  const database = new Database(file, { readonly: true });
  try {
    return database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  } finally {
    database.close();
  }
}

/**
 * Opens (and if needed creates) the state database of a local environment.
 * The database uses write-ahead logging, so several processes can share one
 * state directory; notifications between them fall back to polling.
 *
 * @param directory - The state directory; created when missing.
 * @returns A database handle with the current schema.
 * @throws {HolqaError} `HOLQA_LOCAL_STATE_UNSUPPORTED` when the state was written by a newer, incompatible version.
 */
export function openStateDatabase(directory: string): Database {
  mkdirSync(directory, { recursive: true });
  const database = new Database(join(directory, stateFileName), { create: true, strict: true });
  try {
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA busy_timeout = 5000");
    database.run("PRAGMA foreign_keys = ON");
    const { user_version: version } = database.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    if (version > stateVersion) {
      failWith(
        diagnosticCodes.localStateUnsupported,
        `The local state in "${directory}" has format ${version}; this version of @holqa/local reads format ${stateVersion}.`,
        "Use the version of @holqa/local that wrote it, or point the environment at a new directory."
      );
    }
    database.transaction(() => {
      database.run(schema);
      // Formats 1 and 2 lack trace and lineage columns; `CREATE TABLE IF NOT EXISTS` does not add them to an existing table.
      const columns = new Set(database.query<{ name: string }, []>("PRAGMA table_info(deliveries)").all().map(column => column.name));
      for (const [column, type] of [["correlation_id", "TEXT"], ["causation_id", "TEXT"], ["root_id", "TEXT"], ["depth", "INTEGER"]] as const) {
        if (!columns.has(column))
          database.run(`ALTER TABLE deliveries ADD COLUMN ${column} ${type}`);
      }
      database.run(`PRAGMA user_version = ${stateVersion}`);
    })();
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}