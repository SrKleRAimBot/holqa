import type { ScratchApp } from "@test/support/scratch-app";
import type { DevEvent } from "@/dev/events";

import { existsSync } from "node:fs";
import {
  devContracts,
  devHandlers,
  devInfra,
  scratchApp
} from "@test/support/scratch-app";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout
} from "bun:test";

import { createProcessHost } from "@/analysis/process-host";
import { isProcessAlive } from "@/dev/session";
import { DevSupervisor } from "@/dev/supervisor";
import { operateLocally } from "@/local/local-host";
import { locateApp } from "@/local/locations";

// Every step starts Bun processes; allow for slow machines.
setDefaultTimeout(60_000);

/** The application of this suite. */
let app: ScratchApp;
/** The session under test. */
let supervisor: DevSupervisor;
/** Every event it reported. */
const events: DevEvent[] = [];
/** The session's URL. */
let url: string;

/**
 * Creates a supervisor for the scratch application that does not watch files, so each test reloads explicitly.
 *
 * @returns A supervisor that has not started.
 */
function createSupervisor(): DevSupervisor {
  const host = createProcessHost({ cwd: app.root });
  return new DevSupervisor({ location: locateApp(app.root, undefined, undefined), cwd: app.root, port: 0, hostname: "127.0.0.1", watch: false, analyze: host.analyze, writeFile: host.writeFile, onEvent: event => events.push(event) });
}

/**
 * Returns the events of some types reported since an index.
 *
 * @param since - The first event index to look at.
 * @param types - The event types.
 * @returns The matching events.
 */
function eventsOf<Type extends DevEvent["type"]>(since: number, ...types: Type[]): Array<Extract<DevEvent, { readonly type: Type }>> {
  return events.slice(since).filter((event): event is Extract<DevEvent, { readonly type: Type }> => (types as string[]).includes(event.type));
}

/**
 * Waits until a condition holds.
 *
 * @param condition - Checked every 10 ms.
 * @throws {Error} After ten seconds.
 */
async function until(condition: () => boolean): Promise<void> {
  for (let round = 0; round < 1_000; round += 1) {
    if (condition())
      return;
    await Bun.sleep(10);
  }
  throw new Error("The condition did not hold in time.");
}

/**
 * Requests `GET /api/hello` from the session.
 *
 * @returns The response text.
 */
async function hello(): Promise<string> {
  return (await fetch(new URL("/api/hello", url))).text();
}

beforeAll(async () => {
  app = scratchApp({ "infra.ts": devInfra, "src/contracts.ts": devContracts("string"), "src/app.handler.ts": devHandlers("v1") });
  supervisor = createSupervisor();
  const started = await supervisor.start();
  if (!started.ok)
    throw new Error(JSON.stringify(started.diagnostics));
  url = started.value;
});

afterAll(async () => {
  await supervisor.stop();
  app.remove();
});

describe("holqa dev supervisor", () => {
  it("builds, starts one generation and serves it at a stable address", async () => {
    expect(eventsOf(0, "build")[0]).toMatchObject({ generation: 1, change: { kind: "initial" } });
    expect(eventsOf(0, "generation.ready")[0]).toMatchObject({ generation: 1, summary: { application: "devapp", handlers: expect.arrayContaining([expect.objectContaining({ id: "hello", endpoint: "GET /api/hello" })]) } });
    expect(await hello()).toBe("v1");
    expect(existsSync(locateApp(app.root, undefined, undefined).sessionPath)).toBe(true);
  });

  it("refuses a second session for the same application", async () => {
    const second = createSupervisor();
    const started = await second.start();
    expect(started.ok ? [] : started.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_DEV_SESSION_ACTIVE"]);
  });

  it("traces a request through the message it sends to the consumer it triggers", async () => {
    const since = events.length;
    const response = await fetch(new URL("/api/jobs", url), { method: "POST" });
    const correlationId = response.headers.get("x-correlation-id")!;
    await until(() => eventsOf(since, "log").some(({ entry: { handlerId, message } }) => handlerId === "jobs.run" && message === "invocation completed"));
    const completed = eventsOf(since, "log").map(event => event.entry).filter(({ message }) => message === "invocation completed");
    const { invocationId: enqueued } = completed.find(({ handlerId }) => handlerId === "jobs.enqueue")!;
    expect(completed.find(({ handlerId }) => handlerId === "jobs.run")).toMatchObject({ correlationId, causationId: enqueued, triggerKind: "queue.message", attempt: 1 });
  });

  it("applies a handler change to the next execution without changing the resource graph", async () => {
    const since = events.length;
    app.write("src/app.handler.ts", devHandlers("v2"));
    await supervisor.reload(["src/app.handler.ts"]);
    expect(eventsOf(since, "build")[0]).toMatchObject({ change: { kind: "implementation", contracts: [] } });
    expect(await hello()).toBe("v2");
  });

  it("keeps the previous generation serving when a change breaks the application", async () => {
    const since = events.length;
    const serving = supervisor.stats().serving;
    app.write("src/app.handler.ts", "throw new Error(\"broken on import\");\n");
    await supervisor.reload(["src/app.handler.ts"]);
    const failed = eventsOf(since, "build.failed")[0]!;
    expect(failed.serving).toBe(serving!);
    expect(failed.diagnostics.filter(diagnostic => diagnostic.severity === "error").map(diagnostic => diagnostic.code)).toEqual(["HOLQA_RELOAD_FAILED", "HOLQA_MODULE_EVALUATION_FAILED"]);
    expect(await hello()).toBe("v2");
    app.write("src/app.handler.ts", devHandlers("v3"));
    await supervisor.reload(["src/app.handler.ts"]);
    expect(await hello()).toBe("v3");
  });

  it("reports contract errors and compatibility problems when a schema changes", async () => {
    let since = events.length;
    // A queue whose schema no longer matches its consumer's is a contract error: the reload fails.
    app.write("infra.ts", devInfra.replace("queue(\"jobs\", job)", "queue(\"jobs\")"));
    app.write("src/contracts.ts", devContracts("number"));
    await supervisor.reload(["infra.ts", "src/contracts.ts"]);
    expect(eventsOf(since, "build.failed")[0]?.diagnostics.map(diagnostic => diagnostic.code)).toContain("HOLQA_TRIGGER_INVALID");
    expect(await hello()).toBe("v3");
    // Changing the shared contract reloads, and the compatibility checker reports the breaking change.
    since = events.length;
    app.write("infra.ts", devInfra);
    await supervisor.reload(["infra.ts"]);
    const build = eventsOf(since, "build")[0]!;
    expect(build.change.kind).toBe("resources");
    expect(build.change.contracts.map(diagnostic => diagnostic.code)).toContain("HOLQA_SCHEMA_CHANGE_BREAKING");
    app.write("src/contracts.ts", devContracts("string"));
    await supervisor.reload(["src/contracts.ts"]);
  });

  it("does not accumulate processes, consumers or subscriptions over repeated restarts", async () => {
    const before = supervisor.stats().started;
    const since = events.length;
    for (let round = 0; round < 5; round += 1)
      await supervisor.reload(["src/app.handler.ts"]);
    const stats = supervisor.stats();
    expect(stats.started).toBe(before + 5);
    await until(() => supervisor.stats().alive === 1);
    const pids = eventsOf(since, "generation.ready").map(event => event.pid);
    expect(pids.slice(0, -1).filter(isProcessAlive)).toEqual([]);
    // One consumer: a message is processed exactly once by the serving generation.
    const marker = events.length;
    await fetch(new URL("/api/jobs", url), { method: "POST" });
    await until(() => eventsOf(marker, "log").some(({ entry: { handlerId, message } }) => handlerId === "jobs.run" && message === "invocation completed"));
    await Bun.sleep(200);
    const runs = eventsOf(marker, "log").filter(({ entry: { handlerId, message } }) => handlerId === "jobs.run" && message === "invocation completed");
    expect(runs.map(event => event.generation)).toEqual([stats.serving!]);
  });

  it("runs operations of the CLI in the session", async () => {
    const host = createProcessHost({ cwd: app.root });
    const location = locateApp(app.root, undefined, undefined);
    const sent = await operateLocally({ cwd: app.root, analyze: host.analyze, writeFile: host.writeFile }, location, { kind: "queue.send", queueId: "jobs", message: "from the cli" });
    expect(sent).toMatchObject({ target: "dev", response: { ok: true, result: { queueId: "jobs", messageId: expect.any(String) } } });
    const invoked = await operateLocally({ cwd: app.root, analyze: host.analyze, writeFile: host.writeFile }, location, { kind: "invoke", handlerId: "jobs.run", input: "direct" });
    expect(invoked).toMatchObject({ target: "dev", response: { ok: true, result: { outcome: { ok: true } } } });
    const run = await operateLocally({ cwd: app.root, analyze: host.analyze, writeFile: host.writeFile }, location, { kind: "cron.run", scheduleId: "nightly" });
    expect(run).toMatchObject({ target: "dev", response: { ok: true, result: { run: { status: "succeeded", trigger: "manual" } } } });
    const state = await operateLocally({ cwd: app.root, analyze: host.analyze, writeFile: host.writeFile }, location, { kind: "state" });
    expect(state).toMatchObject({ target: "dev", response: { ok: true, result: { queues: [{ id: "jobs" }], schedules: [{ id: "nightly", runs: [expect.objectContaining({ trigger: "manual", status: "succeeded" })] }] } } });
  });

  it("restarts without re-analysis when only environment files change", async () => {
    const since = events.length;
    app.write(".env", "GREETING_SOURCE=dotenv\n");
    await supervisor.reload([".env"]);
    expect(eventsOf(since, "build")[0]).toMatchObject({ change: { kind: "environment" } });
    expect(eventsOf(since, "output")).toEqual([]);
    expect(await hello()).toBe("v3");
  });

  it("refuses other sessions on its port or its state directory", async () => {
    const other = scratchApp({ "infra.ts": devInfra, "src/contracts.ts": devContracts("string"), "src/app.handler.ts": devHandlers("other") });
    try {
      const host = createProcessHost({ cwd: other.root });
      /**
       * Starts a supervisor for the other application.
       *
       * @param port - The port to listen on.
       * @param stateDir - The state directory to use.
       * @returns The diagnostic codes of a failed start, or an empty list.
       */
      const attempt = async (port: number, stateDir: string | undefined): Promise<string[]> => {
        const candidate = new DevSupervisor({ location: locateApp(other.root, undefined, stateDir), cwd: other.root, port, hostname: "127.0.0.1", watch: false, analyze: host.analyze, writeFile: host.writeFile, onEvent: () => {} });
        const started = await candidate.start();
        await candidate.stop();
        return started.ok ? [] : started.diagnostics.map(diagnostic => diagnostic.code);
      };
      expect(await attempt(Number(new URL(url).port), undefined)).toEqual(["HOLQA_DEV_START_FAILED"]);
      expect(await attempt(0, locateApp(app.root, undefined, undefined).stateDir)).toEqual(["HOLQA_DEV_SESSION_ACTIVE"]);
    } finally {
      other.remove();
    }
  });

  it("reports a generation that exits on its own and answers 503 until the next change", async () => {
    const since = events.length;
    const pid = eventsOf(0, "generation.ready").at(-1)!.pid;
    process.kill(pid, "SIGKILL");
    await until(() => eventsOf(since, "generation.exited").length > 0);
    const response = await fetch(new URL("/api/hello", url));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "HOLQA_LOCAL_OPERATION_FAILED" } });
    await supervisor.reload(["src/app.handler.ts"]);
    expect(await hello()).toBe("v3");
  });

  it("stops the generation and removes the session file", async () => {
    const pid = eventsOf(0, "generation.ready").at(-1)!.pid;
    await supervisor.stop();
    expect(isProcessAlive(pid)).toBe(false);
    expect(existsSync(locateApp(app.root, undefined, undefined).sessionPath)).toBe(false);
    expect(events.at(-1)).toEqual({ type: "dev.stopped" });
  });
});