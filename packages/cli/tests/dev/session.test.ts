import {
  mkdtempSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import {
  activeSession,
  isProcessAlive,
  readSession,
  removeSession,
  sendToSession,
  sessionFormat,
  writeSession
} from "@/dev/session";

/** Directories to remove. */
const cleanups: string[] = [];

afterEach(() => {
  for (const directory of cleanups.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * Creates a session file path in a new directory.
 *
 * @returns The session file path in a fresh directory.
 */
function sessionPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "holqa-session-"));
  cleanups.push(directory);
  return join(directory, ".holqa", "dev", "session.json");
}

describe("dev session files", () => {
  it("are readable by their owner only and removed only by their own session", () => {
    const path = sessionPath();
    const session = { format: sessionFormat, pid: process.pid, url: "http://127.0.0.1:3000/", token: "t1", stateDir: "/state", startedAt: "2026-10-18T09:00:00.000Z" } as const;
    writeSession(path, session);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readSession(path)).toEqual(session);
    removeSession(path, "other");
    expect(readSession(path)).toEqual(session);
    removeSession(path, "t1");
    expect(readSession(path)).toBeUndefined();
  });

  it("finds sessions of running processes and ignores those of processes that no longer run", () => {
    const path = sessionPath();
    writeSession(path, { format: sessionFormat, pid: process.pid, url: "http://127.0.0.1:3000/", token: "t", stateDir: "/s", startedAt: "now" });
    expect(activeSession(path)?.token).toBe("t");
    const dead = Bun.spawnSync(["bun", "-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
    writeSession(path, { format: sessionFormat, pid: Number(dead), url: "http://127.0.0.1:3000/", token: "t", stateDir: "/s", startedAt: "now" });
    expect(isProcessAlive(Number(dead))).toBe(false);
    expect(activeSession(path)).toBeUndefined();
  });

  it("reports an unreachable session as undefined", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 401 }) });
    const url = server.url.href;
    try {
      expect(await sendToSession({ format: sessionFormat, pid: 1, url, token: "wrong", stateDir: "/s", startedAt: "now" }, { kind: "state" }, 1_000)).toBeUndefined();
    } finally {
      await server.stop(true);
    }
    expect(await sendToSession({ format: sessionFormat, pid: 1, url, token: "t", stateDir: "/s", startedAt: "now" }, { kind: "state" }, 1_000)).toBeUndefined();
  });
});