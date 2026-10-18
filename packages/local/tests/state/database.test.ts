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

  it("refuses state written by a newer format", () => {
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    const newer = new Database(join(directory.path, stateFileName), { create: true });
    newer.run(`PRAGMA user_version = ${stateVersion + 1}`);
    newer.close();
    expect(() => openStateDatabase(directory.path)).toThrow("HOLQA_LOCAL_STATE_UNSUPPORTED");
  });
});