import { join } from "node:path";
import { stateDirectory } from "@test/support/fixtures";
import { Database } from "bun:sqlite";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import {
  openStateDatabase,
  readStateFormat,
  stateFileName,
  stateVersion
} from "@/state/database";

/** Directories to remove after each test. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0))
    cleanup();
});

describe("openStateDatabase", () => {
  it("creates the state file with the current format and reopens it", () => {
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    const database = openStateDatabase(join(directory.path, "nested"));
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(stateVersion);
    database.query("INSERT INTO meta (key, value) VALUES ('probe', 'kept')").run();
    database.close();
    const reopened = openStateDatabase(join(directory.path, "nested"));
    expect(reopened.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'probe'").get()?.value).toBe("kept");
    reopened.close();
  });

  it("upgrades format 1 state in place, keeping its deliveries", () => {
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    const old = new Database(join(directory.path, stateFileName), { create: true });
    old.run("CREATE TABLE deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, delivery_id TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, visible_at INTEGER NOT NULL, lease_token TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error_code TEXT, last_error_message TEXT, last_invocation_id TEXT) STRICT");
    old.run("INSERT INTO deliveries (channel, delivery_id, body, state, visible_at, created_at, updated_at) VALUES ('queue:jobs', 'm-1', '{}', 'ready', 0, 0, 0)");
    old.run("PRAGMA user_version = 1");
    old.close();
    const database = openStateDatabase(directory.path);
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(stateVersion);
    expect(database.query<{ delivery_id: string; correlation_id: string | null; root_id: string | null; depth: number | null }, []>("SELECT delivery_id, correlation_id, root_id, depth FROM deliveries").all()).toEqual([{ delivery_id: "m-1", correlation_id: null, root_id: null, depth: null }]);
    expect(database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('operation_budgets', 'idempotency_keys') ORDER BY name").all()).toEqual([{ name: "idempotency_keys" }, { name: "operation_budgets" }]);
    database.close();
  });

  it("upgrades format 2 state in place, adding lineage to deliveries that have a trace", async () => {
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    const old = new Database(join(directory.path, stateFileName), { create: true });
    old.run("CREATE TABLE deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, delivery_id TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, visible_at INTEGER NOT NULL, lease_token TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error_code TEXT, last_error_message TEXT, last_invocation_id TEXT, correlation_id TEXT, causation_id TEXT) STRICT");
    old.run("INSERT INTO deliveries (channel, delivery_id, body, state, visible_at, created_at, updated_at, correlation_id, causation_id) VALUES ('queue:jobs', 'm-1', '{}', 'ready', 0, 0, 0, 'shared', 'inv-1')");
    old.run("PRAGMA user_version = 2");
    old.close();
    const database = openStateDatabase(directory.path);
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(stateVersion);
    expect(database.query<{ correlation_id: string; root_id: string | null; depth: number | null }, []>("SELECT correlation_id, root_id, depth FROM deliveries").all()).toEqual([{ correlation_id: "shared", root_id: null, depth: null }]);
    database.close();
  });

  it("reads the format of a directory without creating or upgrading it", () => {
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    expect(readStateFormat(directory.path)).toBeUndefined();
    const old = new Database(join(directory.path, stateFileName), { create: true });
    old.run("PRAGMA user_version = 1");
    old.close();
    expect(readStateFormat(directory.path)).toBe(1);
    expect(readStateFormat(directory.path)).toBe(1);
  });

  it("refuses state written by a newer format", () => {
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    const newer = new Database(join(directory.path, stateFileName), { create: true });
    newer.run(`PRAGMA user_version = ${stateVersion + 1}`);
    newer.close();
    expect(() => openStateDatabase(directory.path)).toThrow("HOLQA_LOCAL_STATE_UNSUPPORTED");
  });
});