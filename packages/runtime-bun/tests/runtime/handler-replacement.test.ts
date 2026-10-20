import type {
  InvocationContext,
  RuntimeBinding,
  ScopedDefinition
} from "@holqa/core";

import type { Runtime } from "@/index";

import { diagnosticsOf } from "@holqa/core";
import {
  apiResource,
  application,
  latch,
  recordingSink,
  routeHandler,
  scheduleHandler,
  scheduleResource,
  sequentialIds
} from "@test/support/descriptors";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import {
  createRuntime,
  silentSink
} from "@/index";

/** A binding that serves schedules, for handlers run through `runtime.invoke`. */
const scheduleBinding: RuntimeBinding = { name: "test", capabilities: { "schedule": { overlap: ["skip"] }, "http.api": {} }, drivers: {}, config: () => undefined };

/** Metadata of a scheduled run. */
const tick = { scheduledTime: "2026-10-18T03:00:00Z" };

/** The application of these tests. */
const app = application([apiResource("api"), scheduleResource("nightly")]);

/** Runtimes started by a test, stopped afterwards. */
const started: Runtime[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map(runtime => runtime.stop({ graceMs: 100, forceMs: 100 })));
});

/**
 * Builds the schedule handler `nightly.run` that returns a label.
 *
 * @param label - What every invocation resolves to.
 * @param before - Awaited before resolving, to keep an invocation running.
 * @returns The registration.
 */
function nightly(label: string, before?: (context: InvocationContext<{ readonly scheduledTime: string }>) => Promise<void>): ReturnType<typeof scheduleHandler> {
  return scheduleHandler("nightly.run", "nightly", async (context) => {
    await before?.(context);
    return label;
  });
}

/**
 * Creates and starts a runtime for the test application.
 *
 * @param handlers - The initial handler registrations.
 * @param log - Where logs go.
 * @returns The running runtime.
 */
async function start(handlers: readonly unknown[], log = silentSink): Promise<Runtime> {
  const runtime = createRuntime({ app, handlers, binding: scheduleBinding, manualTriggers: true, log, createId: sequentialIds(), limits: { timeoutMs: 2_000 } });
  started.push(runtime);
  await runtime.start();
  return runtime;
}

/**
 * Waits until a condition holds, checking on every turn of the event loop.
 *
 * @param condition - Checked on every turn until it returns `true`.
 * @throws {Error} When it does not hold within two seconds.
 */
async function until(condition: () => boolean): Promise<void> {
  for (let round = 0; round < 2_000; round += 1) {
    if (condition())
      return;
    await Bun.sleep(1);
  }
  throw new Error("The condition did not hold in time.");
}

/**
 * Runs `nightly.run` once.
 *
 * @param runtime - A started runtime of the test application.
 * @returns The value it resolved to, or the failure code.
 */
async function runNightly(runtime: Runtime): Promise<unknown> {
  const outcome = await runtime.invoke({ handlerId: "nightly.run", metadata: tick });
  return outcome.ok ? outcome.value : outcome.failure.code;
}

describe("runtime.replaceHandlers", () => {
  it("runs the new implementation for invocations that start after the replacement", async () => {
    const runtime = await start([nightly("v1"), routeHandler("hello", "api", "GET", "/hello", () => new Response("hi"))]);
    expect(await runNightly(runtime)).toBe("v1");
    const replacement = runtime.replaceHandlers([nightly("v2")], { sources: { "nightly.run": "src/nightly.ts#run" } });
    expect(replacement).toEqual({ version: 2, handlers: ["nightly.run"] });
    expect(await runNightly(runtime)).toBe("v2");
    expect(runtime.handlerVersions()).toEqual([
      { handlerId: "hello", version: 1, active: 0, retiring: [] },
      { handlerId: "nightly.run", version: 2, source: "src/nightly.ts#run", active: 0, retiring: [] }
    ]);
    expect(runtime.stats().versions).toEqual({ version: 2, retiring: 0, retired: 1 });
  });

  it("lets an invocation that is already running finish under the implementation it started with", async () => {
    const gate = latch();
    const runtime = await start([nightly("v1", () => gate.promise)]);
    const running = runNightly(runtime);
    await until(() => runtime.handlerVersions()[0]!.active === 1);
    runtime.replaceHandlers([nightly("v2")]);
    expect(runtime.handlerVersions()[0]).toMatchObject({ version: 2, active: 0, retiring: [{ version: 1, active: 1 }] });
    expect(await runNightly(runtime)).toBe("v2");
    gate.release();
    expect(await running).toBe("v1");
    expect(runtime.handlerVersions()[0]!.retiring).toEqual([]);
  });

  it("ends a long-running invocation of a replaced implementation at its time limit", async () => {
    const runtime = await start([nightly("v1", () => new Promise(() => {}))]);
    const running = runtime.invoke({ handlerId: "nightly.run", metadata: tick, timeoutMs: 50 });
    await until(() => runtime.handlerVersions()[0]!.active === 1);
    runtime.replaceHandlers([nightly("v2")]);
    expect((await running).ok ? "ok" : (await running as { readonly failure: { readonly code: string } }).failure.code).toBe("HOLQA_INVOCATION_TIMEOUT");
    expect(await runNightly(runtime)).toBe("v2");
  });

  it("labels the logs and spans of replaced implementations with their version", async () => {
    const { sink, entries } = recordingSink();
    const runtime = await start([nightly("v1")], sink);
    await runNightly(runtime);
    runtime.replaceHandlers([nightly("v2")]);
    await runNightly(runtime);
    const completed = entries.filter(entry => entry.message === "invocation completed");
    expect(completed.map(entry => (entry as { readonly handlerVersion?: unknown }).handlerVersion)).toEqual([undefined, 2]);
    expect(entries.find(entry => entry.message === "handlers replaced")).toMatchObject({ handlerVersion: 2, handlers: ["nightly.run"] });
  });

  it("replaces nothing and reports every problem when one replacement is invalid", async () => {
    const runtime = await start([nightly("v1")]);
    const changedTrigger = scheduleHandler("nightly.run", "other", () => "x");
    const unknown = scheduleHandler("weekly.run", "nightly", () => "x");
    let error: unknown;
    try {
      runtime.replaceHandlers([nightly("v2"), changedTrigger, unknown, "not a handler"]);
    } catch (caught) {
      error = caught;
    }
    expect(diagnosticsOf(error).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_HANDLER_REPLACEMENT_INVALID", "HOLQA_HANDLER_REPLACEMENT_INVALID", "HOLQA_HANDLER_REPLACEMENT_INVALID"]);
    expect(await runNightly(runtime)).toBe("v1");
    expect(runtime.stats().versions.version).toBe(1);
  });

  it("refuses replacements once the runtime is stopping", async () => {
    const runtime = await start([nightly("v1")]);
    await runtime.stop();
    let error: unknown;
    try {
      runtime.replaceHandlers([nightly("v2")]);
    } catch (caught) {
      error = caught;
    }
    expect(diagnosticsOf(error).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_RUNTIME_NOT_RUNNING"]);
  });

  it("disposes of scoped values that only a retired implementation used, and keeps shared ones", async () => {
    const disposed: string[] = [];
    /**
     * Creates a scoped definition that records its disposal.
     *
     * @param name - The value it creates, also its name.
     * @returns A scoped definition whose disposal is recorded.
     */
    const definition = (name: string): ScopedDefinition<string> => ({ name, create: () => name, dispose: (value) => {
      disposed.push(value);
    } });
    const shared = definition("shared");
    const signals: AbortSignal[] = [];
    /**
     * Builds an implementation that uses the shared value and its own value, then waits.
     *
     * @param own - Its own definition.
     * @param wait - Awaited before resolving.
     * @returns The registration.
     */
    const usingScope = (own: ScopedDefinition<string>, wait: Promise<void>): ReturnType<typeof scheduleHandler> => scheduleHandler("nightly.run", "nightly", async (context) => {
      signals.push(context.scope!.signal);
      const values = [await context.scope!.use(shared), await context.scope!.use(own)];
      await wait;
      return values;
    });
    const first = latch();
    const runtime = await start([usingScope(definition("own-v1"), first.promise)]);
    const running = runNightly(runtime);
    await until(() => runtime.handlerVersions()[0]!.active === 1);
    runtime.replaceHandlers([usingScope(definition("own-v2"), Promise.resolve())]);
    // v2 uses the shared value while v1 is still running, so it survives v1's retirement.
    expect(await runNightly(runtime)).toEqual(["shared", "own-v2"]);
    first.release();
    expect(await running).toEqual(["shared", "own-v1"]);
    await until(() => runtime.stats().versions.retiring === 0 && signals[0]!.aborted && disposed.length === 1);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(disposed).toEqual(["own-v1"]);
    await runtime.stop();
    expect(disposed.sort()).toEqual(["own-v1", "own-v2", "shared"]);
  });
});

describe("repeated replacements (stress)", () => {
  it("keeps one registration per handler and releases every replaced implementation under concurrent load", async () => {
    const created: string[] = [];
    const disposed: string[] = [];
    /**
     * Builds an implementation with its own scoped value and a short wait.
     *
     * @param round - The replacement round.
     * @returns The registration.
     */
    const implementation = (round: number): ReturnType<typeof scheduleHandler> => {
      const own: ScopedDefinition<number> = { name: `round-${round}`, create: () => {
        created.push(`round-${round}`);
        return round;
      }, dispose: () => {
        disposed.push(`round-${round}`);
      } };
      return scheduleHandler("nightly.run", "nightly", async (context) => {
        const value = await context.scope!.use(own);
        await Bun.sleep(1);
        return value;
      });
    };
    const runtime = await start([implementation(0)]);
    const rounds = 200;
    const invocations: Array<Promise<unknown>> = [];
    for (let round = 1; round <= rounds; round += 1) {
      invocations.push(runNightly(runtime), runNightly(runtime));
      runtime.replaceHandlers([implementation(round)]);
      if (round % 20 === 0)
        await Bun.sleep(2);
    }
    const values = await Promise.all(invocations);
    // Every invocation ran the implementation that was current when it got its slot, and none failed.
    expect(values.every(value => typeof value === "number")).toBe(true);
    await until(() => runtime.stats().versions.retiring === 0 && runtime.stats().running === 0);
    const stats = runtime.stats();
    expect(stats.versions).toEqual({ version: rounds + 1, retiring: 0, retired: rounds });
    expect(runtime.handlerVersions()).toEqual([{ handlerId: "nightly.run", version: rounds + 1, active: 0, retiring: [] }]);
    expect(stats.running).toBe(0);
    // Every value a retired implementation created was disposed; only the current implementation's value is alive.
    expect(disposed.sort()).toEqual(created.filter(name => name !== `round-${rounds}`).sort());
    await runtime.stop();
    expect(disposed.sort()).toEqual(created.sort());
  });
});