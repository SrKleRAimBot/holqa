import type { ReloadStrategy } from "@/hosts/types";
import type { Runtime } from "@/runtime";

import {
  afterAll,
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import { createRuntime } from "@/runtime";

import {
  basicEnv,
  copyFixture,
  removeFixtureCopies,
  setFixtureVersion,
  writeFixtureFile
} from "./support/fixture";
import {
  counter,
  rejectionCode,
  waitFor
} from "./support/wait";

const strategies: readonly ReloadStrategy[] = ["in-process", "worker"];
const started: Runtime[] = [];

/**
 * Creates and loads a runtime over a fresh copy of the basic fixture.
 *
 * @param strategy - The reload strategy.
 * @param options - Optional environment and drain period.
 * @param options.env - Configuration values; defaults to a valid set.
 * @param options.drainMs - How long replaced generations may drain.
 * @returns The fixture copy and the loaded runtime.
 */
async function start(strategy: ReloadStrategy, options: { readonly env?: Record<string, string>; readonly drainMs?: number } = {}): Promise<{ readonly root: string; readonly runtime: Runtime }> {
  const root = copyFixture("basic");
  const runtime = createRuntime({ root, strategy, env: options.env ?? basicEnv, drainMs: options.drainMs ?? 5000 });
  started.push(runtime);
  const loaded = await runtime.load();
  if (!loaded.ok)
    throw new Error(JSON.stringify(loaded.error));
  return { root, runtime };
}

/**
 * Posts JSON to the runtime's HTTP adapter.
 *
 * @param runtime - The runtime under test.
 * @param path - The request path.
 * @param body - The JSON body.
 * @returns The response.
 */
async function post(runtime: Runtime, path: string, body: unknown): Promise<Response> {
  return runtime.fetch(new Request(`http://local${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
}

afterEach(async () => {
  await Promise.all(started.splice(0).map(async runtime => runtime.dispose({ graceMs: 0 })));
});

afterAll(() => removeFixtureCopies());

describe.each(strategies)("runtime (%s strategy)", (strategy) => {
  it("serves HTTP routes with validation, 404 and 405", async () => {
    const { runtime } = await start(strategy);
    const response = await post(runtime, "/api/echo/ada", { value: "hi" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "ada", value: "hi", version: "v1", call: 1, mode: "a" });

    const invalid = await post(runtime, "/api/echo/ada", { value: 1 });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { diagnostics: { code: string }[] }).diagnostics[0]?.code).toBe("HOLQA_INPUT_INVALID");
    expect((await post(runtime, "/api/missing", {})).status).toBe(404);
    expect((await runtime.fetch(new Request("http://local/api/echo/ada"))).status).toBe(405);
  });

  it("rejects invalid configuration without echoing secret values", async () => {
    const root = copyFixture("basic");
    const runtime = createRuntime({ root, strategy, env: { TOKEN: "short", MODE: "c" } });
    started.push(runtime);
    const loaded = await runtime.load();
    expect(loaded.ok).toBe(false);
    if (loaded.ok)
      return;
    expect(loaded.error.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_CONFIG_INVALID", "HOLQA_CONFIG_INVALID"]);
    expect(JSON.stringify(loaded.error)).not.toContain("short");
    expect(runtime.stats().generation).toBeUndefined();
  });

  it("delivers queue messages at least once with retries and dead letters", async () => {
    const { runtime } = await start(strategy);
    runtime.enqueue("jobs", { key: "ok", mode: "ok" });
    runtime.enqueue("jobs", { key: "once", mode: "fail-once" });
    runtime.enqueue("jobs", { key: "never", mode: "fail" });
    runtime.enqueue("jobs", { key: "bad", mode: "unknown" });
    await runtime.idle();

    /**
     * Reads a processed marker written by the jobs consumer.
     *
     * @param key - The job key.
     * @returns The recorded attempt number as text, or `undefined` when the job never succeeded.
     */
    const text = (key: string): string | undefined => {
      const body = runtime.getObject("uploads", `processed/${key}`);
      return body === undefined ? undefined : new TextDecoder().decode(body);
    };
    expect(text("ok")).toBe("1");
    expect(text("once")).toBe("2");
    expect(text("never")).toBeUndefined();
    const deadLetters = runtime.deadLetters("jobs");
    expect(deadLetters.map(letter => [letter.message, letter.attempts])).toEqual([
      [{ key: "bad", mode: "unknown" }, 1],
      [{ key: "never", mode: "fail" }, 3]
    ]);
    expect(runtime.queue("jobs")).toMatchObject({ pending: 0, delivered: 2, dropped: 0 });
  });

  it("emits object-created events only for matching prefixes", async () => {
    const { runtime } = await start(strategy);
    runtime.putObject("uploads", "incoming/a.txt", "hello");
    runtime.putObject("uploads", "other/b.txt", "hello");
    await runtime.idle();
    expect(new TextDecoder().decode(runtime.getObject("uploads", "seen/incoming/a.txt"))).toBe("5");
    expect(runtime.getObject("uploads", "seen/other/b.txt")).toBeUndefined();
  });

  it("reloads into a fresh module graph and disposes the previous generation", async () => {
    const { root, runtime } = await start(strategy);
    await post(runtime, "/api/echo/a", { value: "x" });
    const before = await (await post(runtime, "/api/echo/a", { value: "x" })).json() as { call: number; evaluation: number };
    expect(before.call).toBe(2);

    setFixtureVersion(root, "v2");
    const reloaded = await runtime.reload();
    expect(reloaded).toEqual({ ok: true, value: 2 });
    const after = await (await post(runtime, "/api/echo/a", { value: "x" })).json() as { version: string; call: number; evaluation: number };
    expect(after.version).toBe("v2");
    expect(after.call).toBe(1);
    // In-process generations share globalThis, so the evaluation counter increases; each worker has its own globals.
    expect(after.evaluation).toBe(strategy === "worker" ? 1 : before.evaluation + 1);

    await runtime.retired();
    expect(runtime.stats().generations.map(generation => [generation.number, generation.status])).toEqual([[1, "disposed"], [2, "active"]]);
  });

  it("finishes in-flight invocations on their original generation", async () => {
    const { root, runtime } = await start(strategy);
    const inFlight = runtime.invoke("sleep", { body: { ms: 150, ignoreAbort: false } });
    await waitFor(() => counter(runtime.stats().inFlight, "sleep") === 1);
    setFixtureVersion(root, "v2");
    expect((await runtime.reload()).ok).toBe(true);
    const next = runtime.invoke("sleep", { body: { ms: 0, ignoreAbort: false } });
    expect(await inFlight).toMatchObject({ status: 200, body: { version: "v1" } });
    expect(await next).toMatchObject({ status: 200, body: { version: "v2" } });
  });

  it("keeps the previous generation serving when a reload fails", async () => {
    const { root, runtime } = await start(strategy);
    writeFixtureFile(root, "handlers/broken.handler.ts", "export default {;\n");
    const failed = await runtime.reload();
    expect(failed.ok).toBe(false);
    if (!failed.ok)
      expect(failed.error.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_RELOAD_FAILED", "HOLQA_MODULE_EVALUATION_FAILED"]);
    expect(runtime.stats().generation).toBe(1);
    expect((await post(runtime, "/api/echo/a", { value: "x" })).status).toBe(200);

    writeFixtureFile(root, "handlers/broken.handler.ts", "export const fixed = true;\n");
    expect(await runtime.reload()).toEqual({ ok: true, value: 3 });
  });

  it("recovers after a syntax error in a module that handlers import transitively", async () => {
    const { root, runtime } = await start(strategy);
    writeFixtureFile(root, "state.ts", "export const version = {;\n");
    const failed = await runtime.reload();
    expect(failed.ok ? "ok" : failed.error.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_RELOAD_FAILED", "HOLQA_MODULE_EVALUATION_FAILED"]);
    writeFixtureFile(root, "state.ts", "export const evaluation = 0;\nexport const version = \"v3\";\nexport function nextCall(): number {\n  return 1;\n}\n");
    expect((await runtime.reload()).ok).toBe(true);
    expect(await (await post(runtime, "/api/echo/a", { value: "x" })).json()).toMatchObject({ version: "v3" });
  });

  it("recovers after a handler imported a module that did not exist yet", async () => {
    const { root, runtime } = await start(strategy);
    writeFixtureFile(root, "handlers/late.handler.ts", "import { late } from \"../late\";\nexport const value = late;\n");
    const failed = await runtime.reload();
    expect(failed.ok ? "ok" : failed.error.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_RELOAD_FAILED", "HOLQA_MODULE_EVALUATION_FAILED"]);
    writeFixtureFile(root, "late.ts", "export const late = 1;\n");
    expect((await runtime.reload()).ok).toBe(true);
  });

  it("rejects an invalid registration without registering anything", async () => {
    const root = copyFixture("basic");
    writeFixtureFile(root, "handlers/invalid.handler.ts", [
      "import { queue } from \"@holqa/experiment-sdk\";",
      "import { z } from \"zod\";",
      "import { resources } from \"../infra\";",
      "const stray = queue({ id: \"stray\", message: z.string(), schemaVersion: 1 });",
      "export const duplicate = resources.api.route({ id: \"echo\", method: \"GET\", path: \"/dup\", responses: {}, handler: () => { throw new Error(\"unused\"); } });",
      "export const undeclared = stray.consume({ id: \"stray-consumer\", handler: () => {} });",
      "export const second = resources.jobs.consume({ id: \"jobs-second\", handler: () => {} });",
      "export const future = { \"~holqa\": { protocol: 99, type: \"handler\" } };",
      ""
    ].join("\n"));
    const runtime = createRuntime({ root, strategy, env: basicEnv });
    started.push(runtime);
    const loaded = await runtime.load();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.map(diagnostic => diagnostic.code).sort()).toEqual([
        "HOLQA_DECLARATION_INVALID",
        "HOLQA_HANDLER_ID_DUPLICATE",
        "HOLQA_QUEUE_CONSUMER_DUPLICATE",
        "HOLQA_RESOURCE_NOT_FOUND"
      ]);
    }
    expect(runtime.stats().generations).toEqual([]);
    expect(await rejectionCode(runtime.invoke("echo", {}))).toBe("HOLQA_HANDLER_NOT_FOUND");
  });

  it("reports top-level use of configuration as a module evaluation failure", async () => {
    const root = copyFixture("basic");
    writeFixtureFile(root, "handlers/eager.handler.ts", "import { config } from \"../infra\";\nexport const token = config.TOKEN;\n");
    const runtime = createRuntime({ root, strategy, env: basicEnv });
    started.push(runtime);
    const loaded = await runtime.load();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error[0]?.code).toBe("HOLQA_MODULE_EVALUATION_FAILED");
      expect(loaded.error[0]?.message).toContain("not bound");
    }
  });

  it("cancels on timeout and through the caller's signal", async () => {
    const { runtime } = await start(strategy);
    expect(await rejectionCode(runtime.invoke("sleep", { body: { ms: 10_000, ignoreAbort: false } }, { timeoutMs: 20 }))).toBe("HOLQA_INVOCATION_CANCELLED");
    const controller = new AbortController();
    const pending = runtime.invoke("sleep", { body: { ms: 10_000, ignoreAbort: false } }, { signal: controller.signal });
    await waitFor(() => counter(runtime.stats().inFlight, "sleep") === 1);
    controller.abort();
    expect(await rejectionCode(pending)).toBe("HOLQA_INVOCATION_CANCELLED");
    await waitFor(() => runtime.stats().orphaned === 0 && counter(runtime.stats().inFlight, "sleep") === 0);
    expect(runtime.stats().cancelled).toBe(2);
  });

  it("tracks handlers that ignore cancellation as orphaned until they finish", async () => {
    const { runtime } = await start(strategy);
    const result = runtime.invoke("sleep", { body: { ms: 200, ignoreAbort: true } }, { timeoutMs: 10 });
    expect(await rejectionCode(result)).toBe("HOLQA_INVOCATION_CANCELLED");
    expect(runtime.stats().orphaned).toBe(1);
    expect(counter(runtime.stats().inFlight, "sleep")).toBe(1);
    await waitFor(() => runtime.stats().orphaned === 0);
    expect(counter(runtime.stats().inFlight, "sleep")).toBe(0);
  });

  it("disposes idempotently, cancels in-flight work after the grace period and rejects new work", async () => {
    const { runtime } = await start(strategy);
    const inFlight = runtime.invoke("sleep", { body: { ms: 10_000, ignoreAbort: false } });
    await waitFor(() => counter(runtime.stats().inFlight, "sleep") === 1);
    const first = runtime.dispose({ graceMs: 20 });
    const second = runtime.dispose();
    expect(await rejectionCode(runtime.invoke("echo", {}))).toBe("HOLQA_RUNTIME_DISPOSED");
    await Promise.all([first, second]);
    expect(await rejectionCode(inFlight)).toBe("HOLQA_RUNTIME_DISPOSED");
    expect(runtime.stats()).toMatchObject({ status: "disposed", generation: undefined });
    expect(runtime.stats().generations.every(generation => generation.status === "disposed")).toBe(true);
    const reload = await runtime.reload();
    expect(reload.ok ? "ok" : reload.error[0]?.code).toBe("HOLQA_RUNTIME_DISPOSED");
    expect((await post(runtime, "/api/echo/a", { value: "x" })).status).toBe(503);
  });

  it("serializes concurrent reloads", async () => {
    const { runtime } = await start(strategy);
    const results = await Promise.all([runtime.reload(), runtime.reload(), runtime.reload()]);
    expect(results).toEqual([{ ok: true, value: 2 }, { ok: true, value: 3 }, { ok: true, value: 4 }]);
    await runtime.retired();
    expect(runtime.stats().generations.map(generation => generation.status)).toEqual(["disposed", "disposed", "disposed", "active"]);
  });
});