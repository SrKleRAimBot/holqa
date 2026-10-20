import type { ScratchApp } from "@test/support/scratch-app";

import { existsSync } from "node:fs";
import { join } from "node:path";
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
import {
  operateLocally,
  runDoctor
} from "@/local/local-host";
import { locateApp } from "@/local/locations";

// Every operation starts Bun processes; allow for slow machines.
setDefaultTimeout(60_000);

/** The application of this suite. */
let app: ScratchApp;

beforeAll(() => {
  app = scratchApp({ "infra.ts": devInfra, "src/contracts.ts": devContracts("string"), "src/app.handler.ts": devHandlers("v1") });
});

afterAll(() => {
  app.remove();
});

/**
 * Returns the dependencies of the local commands for the scratch application.
 *
 * @returns Analysis and file writing.
 */
function dependencies(): Parameters<typeof operateLocally>[0] {
  const host = createProcessHost({ cwd: app.root });
  return { cwd: app.root, analyze: host.analyze, writeFile: host.writeFile };
}

/**
 * Reads the queues of a `state` operation's result.
 *
 * @param outcome - The outcome of a `state` operation.
 * @returns Its queues, or `undefined` when it failed.
 */
function queuesOf(outcome: Awaited<ReturnType<typeof operateLocally>>): unknown {
  if (!outcome.response.ok)
    return undefined;
  const { queues } = outcome.response.result;
  return queues;
}

describe("operations without a dev session", () => {
  it("send messages into the local state, where they wait for the next dev session", async () => {
    const location = locateApp(app.root, undefined, undefined);
    const sent = await operateLocally(dependencies(), location, { kind: "queue.send", queueId: "jobs", message: "later" });
    expect(sent).toMatchObject({ target: "standalone", response: { ok: true, result: { queueId: "jobs" } } });
    const state = await operateLocally(dependencies(), location, { kind: "state" });
    expect(state.response).toMatchObject({ ok: true, result: { queues: [{ id: "jobs", counts: { ready: 1 } }] } });
    expect(existsSync(join(app.root, ".holqa", "local", "state.sqlite"))).toBe(true);
  });

  it("redrive dead letters, reporting none when the queue has none", async () => {
    const location = locateApp(app.root, undefined, undefined);
    const dry = await operateLocally(dependencies(), location, { kind: "queue.redrive", queueId: "jobs", dryRun: true });
    expect(dry.response).toEqual({ ok: true, result: { queueId: "jobs", dryRun: true, count: 0, messages: [] } });
    const redriven = await operateLocally(dependencies(), location, { kind: "queue.redrive", queueId: "jobs", newOperation: true });
    expect(redriven.response).toEqual({ ok: true, result: { queueId: "jobs", dryRun: false, newOperation: true, count: 0, messages: [] } });
  });

  it("invoke background handlers and run schedules once, without consuming queued work", async () => {
    const location = locateApp(app.root, undefined, undefined);
    const invoked = await operateLocally(dependencies(), location, { kind: "invoke", handlerId: "jobs.run", input: "now", attempt: 2 });
    expect(invoked.response).toMatchObject({ ok: true, result: { outcome: { ok: true }, logs: expect.arrayContaining([expect.objectContaining({ message: "job done" })]) } });
    const run = await operateLocally(dependencies(), location, { kind: "cron.run", scheduleId: "nightly" });
    expect(run.response).toMatchObject({ ok: true, result: { run: { status: "succeeded", trigger: "manual" } } });
    // Invoking and running schedules never consumes queued messages: the count is unchanged.
    const before = await operateLocally(dependencies(), location, { kind: "state" });
    await operateLocally(dependencies(), location, { kind: "invoke", handlerId: "jobs.run", input: "again" });
    const after = await operateLocally(dependencies(), location, { kind: "state" });
    expect(queuesOf(after)).toEqual(queuesOf(before));
  });

  it("report what cannot be done as diagnostics", async () => {
    const location = locateApp(app.root, undefined, undefined);
    /**
     * Runs an operation and collects its diagnostic codes.
     *
     * @param operation - The operation to run.
     * @returns The codes, or an empty list when it succeeded.
     */
    const codes = async (operation: Parameters<typeof operateLocally>[2]): Promise<string[]> => {
      const { response } = await operateLocally(dependencies(), location, operation);
      return response.ok ? [] : response.diagnostics.map(diagnostic => diagnostic.code);
    };
    expect(await codes({ kind: "invoke", handlerId: "hello" })).toEqual(["HOLQA_OPERATION_INVALID"]);
    expect(await codes({ kind: "invoke", handlerId: "nope" })).toEqual(["HOLQA_HANDLER_NOT_FOUND"]);
    expect(await codes({ kind: "queue.send", queueId: "nope", message: "x" })).toEqual(["HOLQA_RESOURCE_NOT_FOUND"]);
    expect(await codes({ kind: "queue.send", queueId: "jobs", message: "x", delaySeconds: -1 })).toEqual(["HOLQA_OPERATION_INVALID"]);
    expect(await codes({ kind: "storage.put", bucketId: "nope", key: "a", body: "" })).toEqual(["HOLQA_RESOURCE_NOT_FOUND"]);
    expect(await codes({ kind: "queue.redrive", queueId: "nope" })).toEqual(["HOLQA_RESOURCE_NOT_FOUND"]);
    expect(await codes({ kind: "state" }).then(() => operateLocally(dependencies(), locateApp(app.root, "missing.ts", undefined), { kind: "state" })).then(outcome => outcome.response.ok ? [] : outcome.response.diagnostics.map(diagnostic => diagnostic.code))).toEqual(["HOLQA_APP_NOT_FOUND"]);
  });
});

describe("doctor", () => {
  it("checks the application, its capabilities and the local environment without changing the state", async () => {
    const location = locateApp(app.root, undefined, undefined);
    const checks = await runDoctor(dependencies(), { location, port: 0, hostname: "127.0.0.1" });
    expect(checks.map(check => [check.name, check.status])).toEqual([
      ["bun", "ok"],
      ["application", "ok"],
      ["analysis", "warning"],
      ["configuration", "ok"],
      ["capabilities", "ok"],
      ["state", "ok"],
      ["session", "ok"],
      ["port", "ok"]
    ]);
  });

  it("reports missing configuration by name only", async () => {
    const { PATH: path } = process.env;
    const withSecret = scratchApp({ "infra.ts": "import { application, queue, secret } from \"@test/support/descriptors\";\n\nexport default application(\"secretive\", [queue(\"jobs\")], [secret(\"API_TOKEN\")]);\n" });
    try {
      const checks = await runDoctor({ ...dependencies(), cwd: withSecret.root, env: { PATH: path } }, { location: locateApp(withSecret.root, undefined, undefined), port: 0, hostname: "127.0.0.1" });
      const configuration = checks.find(check => check.name === "configuration")!;
      expect(configuration.status).toBe("error");
      expect(JSON.stringify(configuration)).toContain("API_TOKEN");
      expect(JSON.stringify(configuration)).toContain("HOLQA_CONFIG_INVALID");
      expect(checks.find(check => check.name === "state")).toMatchObject({ status: "ok", message: expect.stringContaining("No local state yet") });
    } finally {
      withSecret.remove();
    }
  });

  it("stops at a missing application", async () => {
    const checks = await runDoctor(dependencies(), { location: locateApp(app.root, "missing.ts", undefined), port: 0, hostname: "127.0.0.1" });
    expect(checks.map(check => [check.name, check.status])).toEqual([["bun", "ok"], ["application", "error"]]);
  });
});