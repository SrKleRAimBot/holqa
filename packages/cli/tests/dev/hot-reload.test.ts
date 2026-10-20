import type { ScratchApp } from "@test/support/scratch-app";
import type { DevEvent } from "@/dev/events";

import {
  devContracts,
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
import { DevSupervisor } from "@/dev/supervisor";
import { operateLocally } from "@/local/local-host";
import { locateApp } from "@/local/locations";

// Every step starts Bun processes; allow for slow machines.
setDefaultTimeout(60_000);

/**
 * The main handler module: a greeting from a helper module, a slow route, a
 * route that sends a job, the job's consumer and a schedule handler.
 *
 * @param label - Which implementation this is; every handler reports it.
 * @param extra - Code appended at module top level.
 * @returns The module source.
 */
function handlers(label: string, extra = ""): string {
  return `import app from "../infra";
import { route, send, tick, worker } from "@test/support/descriptors";
import { job } from "./contracts";
import { greeting } from "./greeting";

export const hello = route("hello", "api", "GET", "/hello", () => new Response(\`\${greeting} ${label}\`));
export const slow = route("slow", "api", "GET", "/slow", async () => {
  console.log("slow started ${label}");
  await Bun.sleep(400);
  return new Response("slow ${label}");
});
export const listeners = route("listeners", "api", "GET", "/listeners", () => Response.json({ exit: process.listenerCount("exit"), sigterm: process.listenerCount("SIGTERM") }));
export const enqueue = route("jobs.enqueue", "api", "POST", "/jobs", async () => Response.json({ messageId: await send(app, "jobs", "work") }));
export const run = worker("jobs.run", "jobs", (message, context) => context.log.info("job done", { label: "${label}" }), job);
export const nightly = tick("nightly.run", "nightly", () => {});
${extra}`;
}

/**
 * A second handler module that imports nothing the first one imports.
 *
 * @param label - What its route answers.
 * @returns The module source.
 */
function other(label: string): string {
  return `import { route } from "@test/support/descriptors";

export const other = route("other", "api", "GET", "/other", () => new Response("${label}"));
`;
}

/**
 * Reads a log entry's message and label.
 *
 * @param entry - The structured log entry of a `log` event.
 * @param entry.message - What the entry says happened.
 * @param entry.label - The implementation label the fixture logs.
 * @returns The message and label.
 */
function fieldsOf(entry: { readonly message?: unknown; readonly label?: unknown }): { readonly message: unknown; readonly label: unknown } {
  return { message: entry.message, label: entry.label };
}

/** The application of this suite. */
let app: ScratchApp;
/** The session under test. */
let supervisor: DevSupervisor;
/** Every event it reported. */
const events: DevEvent[] = [];
/** The session's URL. */
let url: string;

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
 * Requests a path from the session.
 *
 * @param path - The path, for example `/api/hello`.
 * @returns The response text.
 */
async function get(path: string): Promise<string> {
  return (await fetch(new URL(path, url))).text();
}

/**
 * Changes a file and reloads.
 *
 * @param path - The file, relative to the application root.
 * @param contents - Its new contents.
 * @returns The index of the first event of the reload.
 */
async function change(path: string, contents: string): Promise<number> {
  const since = events.length;
  app.write(path, contents);
  await supervisor.reload([path]);
  return since;
}

beforeAll(async () => {
  app = scratchApp({ "infra.ts": devInfra, "src/contracts.ts": devContracts("string"), "src/greeting.ts": "export const greeting = \"hello\";\n", "src/app.handler.ts": handlers("v1"), "src/other.handler.ts": other("other v1") });
  const host = createProcessHost({ cwd: app.root });
  supervisor = new DevSupervisor({ location: locateApp(app.root, undefined, undefined), cwd: app.root, port: 0, hostname: "127.0.0.1", watch: false, analyze: host.analyze, writeFile: host.writeFile, onEvent: event => events.push(event), maxSwaps: 40 });
  const started = await supervisor.start();
  if (!started.ok)
    throw new Error(JSON.stringify(started.diagnostics));
  url = started.value;
});

afterAll(async () => {
  await supervisor.stop();
  app.remove();
});

// The tests share one session and run in order: each starts from the code the previous one left.
describe("holqa dev hot handler replacement", () => {
  it("replaces a changed handler in the running process without recreating local state", async () => {
    // A message waits in the local queue while the handlers change.
    const host = createProcessHost({ cwd: app.root });
    const location = locateApp(app.root, undefined, undefined);
    const before = supervisor.stats();
    const since = await change("src/app.handler.ts", handlers("v2"));
    expect(eventsOf(since, "build")[0]?.reload).toEqual({ strategy: "swap", modules: ["src/app.handler.ts"], handlers: ["hello", "jobs.enqueue", "jobs.run", "listeners", "nightly.run", "slow"] });
    expect(eventsOf(since, "handlers.swapped")[0]).toMatchObject({ generation: before.serving!, version: 2 });
    expect(await get("/api/hello")).toBe("hello v2");
    expect(supervisor.stats()).toMatchObject({ serving: before.serving!, started: before.started, alive: 1 });
    const marker = events.length;
    const sent = await operateLocally({ cwd: app.root, analyze: host.analyze, writeFile: host.writeFile }, location, { kind: "queue.send", queueId: "jobs", message: "after the swap" });
    expect(sent.target).toBe("dev");
    await until(() => eventsOf(marker, "log").some(({ entry }) => fieldsOf(entry).message === "job done"));
    expect(eventsOf(marker, "log").find(({ entry }) => fieldsOf(entry).message === "job done")?.entry).toMatchObject({ label: "v2", handlerVersion: 2 });
  });

  it("invalidates only the handler modules that import a changed helper", async () => {
    const since = await change("src/greeting.ts", "export const greeting = \"hi\";\n");
    const swapped = eventsOf(since, "handlers.swapped")[0]!;
    expect(swapped.modules).toEqual(["src/app.handler.ts"]);
    expect(swapped.handlers).not.toContain("other");
    expect(swapped.versions.find(version => version.handlerId === "other")?.version).toBe(1);
    expect(await get("/api/hello")).toBe("hi v2");
    expect(await get("/api/other")).toBe("other v1");
  });

  it("lets a request that is already running finish under the implementation it started with", async () => {
    const marker = events.length;
    const running = get("/api/slow");
    // Wait until the request is running in the generation, so it is pinned to v2.
    await until(() => eventsOf(marker, "output").some(event => event.line === "slow started v2"));
    await change("src/app.handler.ts", handlers("v3"));
    expect(await get("/api/slow")).toBe("slow v3");
    expect(await running).toBe("slow v2");
  });

  it("keeps the last working implementation serving and flags it stale when a change breaks the code", async () => {
    let since = await change("src/app.handler.ts", "export const broken = ;\n");
    const failed = eventsOf(since, "build.failed")[0]!;
    expect(failed).toMatchObject({ serving: supervisor.stats().serving!, stale: true });
    expect(await get("/api/hello")).toBe("hi v3");
    expect(supervisor.status().stale?.files).toEqual(["src/app.handler.ts"]);
    since = await change("src/app.handler.ts", handlers("v4"));
    expect(eventsOf(since, "handlers.swapped")).toHaveLength(1);
    expect(supervisor.status().stale).toBeUndefined();
    expect(await get("/api/hello")).toBe("hi v4");
  });

  it("restarts instead when a changed module creates timers or listeners while loading", async () => {
    const before = supervisor.stats();
    const since = await change("src/app.handler.ts", handlers("v5", "setInterval(() => {}, 60_000);\nprocess.on(\"exit\", () => {});\n"));
    const sequence = events.slice(since).filter(event => event.type !== "log" && event.type !== "output" && event.type !== "generation.stopped");
    expect(sequence.map(event => event.type)).toEqual(["change", "build", "handlers.swap-refused", "build", "generation.ready"]);
    expect(sequence[1]).toMatchObject({ reload: { strategy: "swap" } });
    expect(sequence[2]).toMatchObject({ reason: "side-effects" });
    expect(sequence[3]).toMatchObject({ generation: before.serving! + 1, reload: { strategy: "restart", reason: "side-effects" } });
    expect(supervisor.stats().started).toBe(before.started + 1);
    expect(await get("/api/hello")).toBe("hi v5");
    // Restarting again leaves the module's effects running only in the new process.
    await change("src/app.handler.ts", handlers("v6"));
  });

  it("restarts for changes to the application module and to modules marked for restarts", async () => {
    let since = await change("infra.ts", `${devInfra}\n`);
    expect(eventsOf(since, "build")[0]?.reload).toMatchObject({ strategy: "restart", reason: "application-module" });
    since = await change("src/other.handler.ts", `// holqa:restart-on-change\n${other("other v2")}`);
    expect(eventsOf(since, "build")[0]?.reload).toMatchObject({ strategy: "restart", reason: "restart-marker" });
    expect(await get("/api/other")).toBe("other v2");
  });

  it("does not accumulate listeners, consumers or retiring versions over repeated replacements (stress)", async () => {
    const before = supervisor.stats();
    const baseline = await get("/api/listeners");
    for (let round = 0; round < 30; round += 1)
      await change("src/app.handler.ts", handlers(`round ${round}`));
    expect(supervisor.stats()).toMatchObject({ started: before.started, alive: 1, swaps: before.swaps + 30 });
    expect(await get("/api/hello")).toBe("hi round 29");
    expect(await get("/api/listeners")).toBe(baseline);
    const host = createProcessHost({ cwd: app.root });
    const location = locateApp(app.root, undefined, undefined);
    const versions = await operateLocally({ cwd: app.root, analyze: host.analyze, writeFile: host.writeFile }, location, { kind: "handlers" });
    const list = versions.response.ok ? (versions.response.result as { readonly versions?: unknown }).versions as ReadonlyArray<{ readonly retiring: readonly unknown[] }> : [];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every(version => version.retiring.length === 0)).toBe(true);
    // One consumer: a message is processed exactly once, by the newest implementation.
    const marker = events.length;
    await fetch(new URL("/api/jobs", url), { method: "POST" });
    await until(() => eventsOf(marker, "log").some(({ entry }) => fieldsOf(entry).message === "job done"));
    await Bun.sleep(200);
    expect(eventsOf(marker, "log").filter(({ entry }) => fieldsOf(entry).message === "job done").map(({ entry }) => fieldsOf(entry).label)).toEqual(["round 29"]);
  });

  it("restarts the process after the configured number of replacements", async () => {
    const before = supervisor.stats();
    let restarted: number | undefined;
    for (let round = 0; round < 45 && restarted === undefined; round += 1) {
      const since = await change("src/app.handler.ts", handlers(`limit ${round}`));
      if (eventsOf(since, "build")[0]?.reload?.strategy === "restart")
        restarted = round;
    }
    expect(restarted).toBeDefined();
    expect(events.filter(event => event.type === "build").at(-1)?.reload).toMatchObject({ reason: "swap-limit" });
    expect(supervisor.stats().started).toBe(before.started + 1);
  });

  it("serves a read-only dashboard over the session's status, state, logs and traces", async () => {
    const page = await fetch(new URL("/_holqa/dashboard", url));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain("<title>holqa dev</title>");
    const status = await (await fetch(new URL("/_holqa/dashboard/api/status", url))).json() as { readonly serving: { readonly generation: number }; readonly reloads: ReadonlyArray<{ readonly outcome: string }>; readonly summary: { readonly handlers: readonly unknown[] } };
    expect(status.serving.generation).toBe(supervisor.stats().serving!);
    expect(status.reloads.map(reload => reload.outcome)).toContain("swapped");
    expect(status.summary.handlers.length).toBeGreaterThan(0);
    const state = await (await fetch(new URL("/_holqa/dashboard/api/state", url))).json() as { readonly queues: ReadonlyArray<{ readonly id: string; readonly messages: ReadonlyArray<Record<string, unknown>> }> };
    const jobs = state.queues.find(queue => queue.id === "jobs")!;
    expect(jobs.messages.length).toBeGreaterThan(0);
    // Message contents are never shown on the dashboard.
    expect(jobs.messages.every(message => !("payload" in message))).toBe(true);
    const logs = await (await fetch(new URL("/_holqa/dashboard/api/logs", url))).json() as { readonly entries: readonly unknown[] };
    expect(logs.entries.length).toBeGreaterThan(0);
    const traces = await fetch(new URL("/_holqa/dashboard/api/traces", url));
    expect(traces.status).toBe(200);
    // A request for another host name (for example through DNS rebinding) is refused.
    const rebound = await fetch(new URL("/_holqa/dashboard/api/status", url), { headers: { host: "attacker.example" } });
    expect(rebound.status).toBe(403);
    const post = await fetch(new URL("/_holqa/dashboard/api/status", url), { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("checks messages waiting in a queue against its changed contract and keeps them", async () => {
    const host = createProcessHost({ cwd: app.root });
    const location = locateApp(app.root, undefined, undefined);
    const sent = await operateLocally({ cwd: app.root, analyze: host.analyze, writeFile: host.writeFile }, location, { kind: "queue.send", queueId: "jobs", message: "waiting", delaySeconds: 3_600 });
    expect(sent.response.ok).toBe(true);
    const since = await change("src/contracts.ts", devContracts("number"));
    expect(eventsOf(since, "build")[0]?.reload).toMatchObject({ strategy: "restart", reason: "contract" });
    const warning = eventsOf(since, "log").find(({ entry }) => fieldsOf(entry).message === "messages waiting in a queue do not match its changed message contract")?.entry;
    expect(warning).toMatchObject({ code: "HOLQA_QUEUED_MESSAGE_INCOMPATIBLE", resourceId: "jobs", incompatible: 1 });
    const state = await operateLocally({ cwd: app.root, analyze: host.analyze, writeFile: host.writeFile }, location, { kind: "state" });
    expect(JSON.stringify(state.response)).toContain("\"waiting\"");
    await change("src/contracts.ts", devContracts("string"));
  });

  it("restarts on every change when hot replacement is turned off", async () => {
    const other = scratchApp({ "infra.ts": devInfra, "src/contracts.ts": devContracts("string"), "src/greeting.ts": "export const greeting = \"cold\";\n", "src/app.handler.ts": handlers("c1") });
    const coldEvents: DevEvent[] = [];
    const host = createProcessHost({ cwd: other.root });
    const cold = new DevSupervisor({ location: locateApp(other.root, undefined, undefined), cwd: other.root, port: 0, hostname: "127.0.0.1", watch: false, hot: false, dashboard: false, analyze: host.analyze, writeFile: host.writeFile, onEvent: event => coldEvents.push(event) });
    try {
      const started = await cold.start();
      expect(started.ok).toBe(true);
      other.write("src/app.handler.ts", handlers("c2"));
      await cold.reload(["src/app.handler.ts"]);
      expect(coldEvents.filter(event => event.type === "build").at(-1)?.reload).toMatchObject({ strategy: "restart", reason: "hot-disabled" });
      expect(cold.stats()).toMatchObject({ started: 2, swaps: 0 });
      expect(await (await fetch(new URL("/api/hello", cold.url))).text()).toBe("cold c2");
      expect((await fetch(new URL("/_holqa/dashboard", cold.url))).status).toBe(404);
    } finally {
      await cold.stop();
      other.remove();
    }
  });
});