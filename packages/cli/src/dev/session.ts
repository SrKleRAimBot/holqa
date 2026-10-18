import type {
  LocalOperation,
  OperationResponse
} from "@/local/protocol";

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  dirname,
  join
} from "node:path";

import { readOperationResponse } from "@/local/protocol";

/** The format tag of the session file. */
export const sessionFormat = "holqa.dev-session/1";

/**
 * A running `holqa dev`, as recorded in `.holqa/dev/session.json` next to the
 * application. The file locks the application against a second session and
 * tells the operation commands where to send their operations. Its token is a
 * bearer credential for the session's control endpoint; the file is readable
 * by its owner only.
 */
export interface DevSession {
  readonly format: typeof sessionFormat;
  readonly pid: number;
  /** The dev server's URL, for example `http://127.0.0.1:3000/`. */
  readonly url: string;
  readonly token: string;
  readonly stateDir: string;
  readonly startedAt: string;
}

/**
 * Returns the lock a session also writes into its state directory, so that
 * two sessions never consume the same local state, even for different
 * applications.
 *
 * @param stateDir - The state directory.
 * @returns The lock file's path.
 */
export function stateLockPath(stateDir: string): string {
  return join(stateDir, "dev-session.json");
}

/** The path of the control endpoint, under the dev server's URL. */
export const operationsPath = "/_holqa/dev/operations";

/**
 * Reads a session file.
 *
 * @param path - The session file.
 * @returns The session, or `undefined` when there is none or it is malformed.
 */
export function readSession(path: string): DevSession | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A missing or unreadable file means there is no session.
    return undefined;
  }
  if (typeof value !== "object" || value === null)
    return undefined;
  const { format, pid, url, token, stateDir, startedAt } = value as Record<string, unknown>;
  if (format !== sessionFormat || typeof pid !== "number" || !Number.isSafeInteger(pid) || typeof url !== "string" || !URL.canParse(url) || typeof token !== "string" || typeof stateDir !== "string" || typeof startedAt !== "string")
    return undefined;
  return { format, pid, url, token, stateDir, startedAt };
}

/**
 * Writes a session file that only its owner can read.
 *
 * @param path - The session file.
 * @param session - The running session to record.
 */
export function writeSession(path: string, session: DevSession): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Removes a session file if it still belongs to the given session.
 *
 * @param path - The session file.
 * @param token - The token of the session that may remove the file.
 */
export function removeSession(path: string, token: string): void {
  if (readSession(path)?.token === token)
    rmSync(path, { force: true });
}

/**
 * Reports whether a process is running.
 *
 * @param pid - The process identifier.
 * @returns `true` when a process with that identifier exists.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as { readonly code?: unknown }).code === "EPERM";
  }
}

/**
 * Finds the running dev session of an application.
 *
 * @param path - The session file.
 * @returns The session when its process is alive, otherwise `undefined` (a stale file is ignored).
 */
export function activeSession(path: string): DevSession | undefined {
  const session = readSession(path);
  return session !== undefined && isProcessAlive(session.pid) ? session : undefined;
}

/**
 * Sends an operation to a running dev session.
 *
 * @param session - The running session to send to.
 * @param operation - The operation to run in it.
 * @param timeoutMs - How long to wait for the response.
 * @returns The response, or `undefined` when the session cannot be reached.
 */
export async function sendToSession(session: DevSession, operation: LocalOperation, timeoutMs: number): Promise<OperationResponse | undefined> {
  let response: Response;
  try {
    response = await fetch(new URL(operationsPath, session.url), {
      method: "POST",
      headers: { "authorization": `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    // Not reachable: the session is shutting down or its server failed.
    return undefined;
  }
  if (response.status !== 200)
    return undefined;
  return readOperationResponse(await response.json().catch(() => undefined));
}