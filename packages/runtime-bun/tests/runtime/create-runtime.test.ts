import type {
  HandlerDescriptor,
  RuntimeBinding
} from "@holqa/core";

import type { RuntimeOptions } from "@/index";

import {
  descriptorKey,
  diagnosticsOf,
  readConfig
} from "@holqa/core";
import {
  anySchema,
  apiResource,
  application,
  configEntry,
  described,
  id,
  latch,
  nonEmptyString,
  queueResource,
  recordingSink,
  routeHandler,
  scheduleHandler,
  scheduleResource,
  sequentialIds
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  createRuntime,
  silentSink
} from "@/index";

/** A binding that serves schedules, for handlers run through `runtime.invoke`. */
const scheduleBinding: RuntimeBinding = { name: "test", capabilities: { schedule: { overlap: ["skip"] } }, drivers: {}, config: () => undefined };

/** Metadata of a scheduled run. */
const tick = { scheduledTime: "2026-10-18T03:00:00Z" };

/**
 * Creates a runtime with silent logs and sequential identifiers.
 *
 * @param options - Overrides of the defaults.
 * @returns An idle runtime.
 */
function runtimeOf(options: Partial<RuntimeOptions> & Pick<RuntimeOptions, "app" | "handlers">): ReturnType<typeof createRuntime> {
  return createRuntime({ env: {}, log: silentSink, createId: sequentialIds(), ...options });
}

/**
 * Collects the diagnostic codes of a thrown Holqa error.
 *
 * @param run - The function expected to throw.
 * @returns The diagnostic codes, or an empty list when nothing was thrown.
 */
function thrownCodes(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    return diagnosticsOf(error).map(diagnostic => diagnostic.code);
  }
  return [];
}

/**
 * Collects the diagnostic codes of a rejected promise.
 *
 * @param promise - The promise expected to reject.
 * @returns The diagnostic codes, or an empty list when it resolves.
 */
async function rejectedCodes(promise: Promise<unknown>): Promise<string[]> {
  return promise.then(() => [], (error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
}

describe("createRuntime", () => {
  it("reports every problem with the application and its handlers at once", () => {
    const app = application([apiResource("api"), scheduleResource("nightly")]);
    const duplicateA = routeHandler("orders.get", "api", "GET", "/orders/:id");
    const duplicateB = routeHandler("orders.get", "api", "GET", "/other");
    const orphan = routeHandler("orders.list", "missing-api", "GET", "/orders");
    const wrongKind = routeHandler("orders.wrong", "nightly", "GET", "/x");
    const conflictA = routeHandler("orders.by-id", "api", "GET", "/orders/:orderId");
    expect(thrownCodes(() => runtimeOf({ app, handlers: [duplicateA, duplicateB, orphan, wrongKind, conflictA, { not: "a handler" }], limits: { concurrency: 0 } }))).toEqual([
      "HOLQA_RUNTIME_START_FAILED",
      "HOLQA_HANDLER_ID_DUPLICATE",
      "HOLQA_RESOURCE_NOT_FOUND",
      "HOLQA_TRIGGER_INVALID",
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_ROUTE_CONFLICT"
    ]);
  });

  it("refuses to start when the binding cannot deliver a handler's trigger, unless it is only invoked manually", async () => {
    const app = application([scheduleResource("nightly")]);
    const handler = scheduleHandler("nightly.run", "nightly", () => undefined);
    const runtime = runtimeOf({ app, handlers: [handler], binding: scheduleBinding });
    const error = await runtime.start().catch((caught: unknown) => caught);
    expect(diagnosticsOf(error).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_BINDING_CAPABILITY_UNSUPPORTED"]);
    expect(runtime.state).toBe("stopped");
    const manual = runtimeOf({ app, handlers: [handler], manualTriggers: true, binding: scheduleBinding });
    await manual.start();
    expect(manual.state).toBe("running");
    await manual.stop();
  });

  it("refuses to start when the binding lacks a store that event limits or idempotent handlers need", async () => {
    const app = application([scheduleResource("nightly")]);
    const handler = scheduleHandler("nightly.run", "nightly", () => undefined);
    const budgeted = runtimeOf({ app, handlers: [handler], manualTriggers: true, binding: scheduleBinding, events: { maxEventsPerOperation: 10 } });
    expect(await rejectedCodes(budgeted.start())).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_BINDING_CAPABILITY_UNSUPPORTED"]);
    const idempotent = { "~holqa": { ...handler["~holqa"], definition: { ...handler["~holqa"].definition, idempotency: { key: "delivery", retentionSeconds: 60, leaseSeconds: 30 } } } };
    const unsupported = runtimeOf({ app: application([scheduleResource("nightly")]), handlers: [idempotent], manualTriggers: true, binding: scheduleBinding });
    expect(await rejectedCodes(unsupported.start())).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_BINDING_CAPABILITY_UNSUPPORTED"]);
    expect(thrownCodes(() => runtimeOf({ app, handlers: [handler], events: { maxDepth: 0 } }))).toEqual(["HOLQA_RUNTIME_START_FAILED"]);
  });

  it("makes every direct invocation a root of its own lineage", async () => {
    const app = application([scheduleResource("nightly")]);
    const runtime = runtimeOf({ app, manualTriggers: true, handlers: [scheduleHandler("nightly.run", "nightly", () => "done")], binding: scheduleBinding });
    await runtime.start();
    const outcome = await runtime.invoke({ handlerId: "nightly.run", metadata: { scheduledTime: "2026-10-18T03:00:00Z" }, rootId: "someone-else", depth: 9 });
    expect(outcome.lineage).toEqual({ correlationId: outcome.invocationId, rootId: outcome.invocationId, depth: 0 });
    await runtime.stop();
  });

  it("rejects values that are not applications", () => {
    expect(thrownCodes(() => runtimeOf({ app: { name: "shop" }, handlers: [] }))).toEqual(["HOLQA_APP_INVALID"]);
  });

  it("accepts the same registration listed twice", () => {
    const route = routeHandler("orders.get", "api", "GET", "/orders/:id");
    expect(runtimeOf({ app: application([apiResource("api")]), handlers: [route, route] }).handlers.map(handler => String(handler.id))).toEqual(["orders.get"]);
  });

  it("rejects conflicting routes across APIs that share a base path", () => {
    const app = application([apiResource("public-api"), apiResource("admin-api")]);
    expect(thrownCodes(() => runtimeOf({ app, handlers: [routeHandler("a", "public-api", "GET", "/x"), routeHandler("b", "admin-api", "GET", "/x")] }))).toEqual(["HOLQA_ROUTE_CONFLICT"]);
  });
});

describe("runtime lifecycle", () => {
  it("moves from idle to running to stopped, and accepts work only while running", async () => {
    const app = application([scheduleResource("nightly")]);
    const runtime = runtimeOf({ app, manualTriggers: true, handlers: [scheduleHandler("nightly.run", "nightly", () => "done")], binding: scheduleBinding });
    expect(runtime.state).toBe("idle");
    const early = await runtime.invoke({ handlerId: "nightly.run" });
    expect(!early.ok && early.failure.code).toBe("HOLQA_RUNTIME_NOT_RUNNING");
    await runtime.start();
    expect(runtime.state).toBe("running");
    const outcome = await runtime.invoke({ handlerId: "nightly.run", metadata: { scheduledTime: "2026-10-18T03:00:00Z" } });
    expect(outcome).toMatchObject({ ok: true, value: "done", handlerId: "nightly.run", invocationId: "inv-2", correlationId: "inv-2" });
    await runtime.stop();
    expect(runtime.state).toBe("stopped");
    const late = await runtime.invoke({ handlerId: "nightly.run" });
    expect(!late.ok && late.failure.code).toBe("HOLQA_RUNTIME_NOT_RUNNING");
    expect(await rejectedCodes(runtime.start())).toEqual(["HOLQA_RUNTIME_START_FAILED"]);
  });

  it("installs the binding while running and removes it when stopped", async () => {
    const value = configEntry("REGION", nonEmptyString, { defaultValue: "eu" });
    const app = application([apiResource("api")], [value]);
    const runtime = runtimeOf({ app, handlers: [], env: { REGION: "us" } });
    await runtime.start();
    expect(readConfig(app[descriptorKey], value)).toBe("us");
    await runtime.stop();
    expect(() => readConfig(app[descriptorKey], value)).toThrow("not bound");
  });

  it("refuses to start a second runtime on an application instance that is already bound", async () => {
    const app = application([apiResource("api")]);
    const first = runtimeOf({ app, handlers: [] });
    await first.start();
    const second = runtimeOf({ app, handlers: [] });
    expect(await rejectedCodes(second.start())).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_RUNTIME_ALREADY_BOUND"]);
    expect(second.state).toBe("stopped");
    await first.stop();
  });

  it("fails to start when configuration is invalid, without revealing secret values", async () => {
    const app = application([apiResource("api")], [
      configEntry("API_TOKEN", nonEmptyString, { sensitive: true }),
      configEntry("REGION", nonEmptyString),
      configEntry("MODE", nonEmptyString, { defaultValue: "live" })
    ]);
    const runtime = runtimeOf({ app, handlers: [], env: { API_TOKEN: "", REGION: undefined } });
    const error = await runtime.start().then(() => undefined, (failure: unknown) => failure);
    expect(diagnosticsOf(error).map(diagnostic => [diagnostic.code, diagnostic.details])).toEqual([
      ["HOLQA_RUNTIME_START_FAILED", undefined],
      ["HOLQA_CONFIG_INVALID", { name: "API_TOKEN", kind: "secret", missing: false }],
      ["HOLQA_CONFIG_INVALID", { name: "REGION", kind: "variable", missing: true }]
    ]);
    expect(diagnosticsOf(error)[1]?.message).toBe("The secret API_TOKEN does not satisfy its schema.");
  });

  it("fails to start an application whose resources the default binding cannot serve", async () => {
    const runtime = runtimeOf({ app: application([apiResource("api"), queueResource("orders")]), handlers: [] });
    expect(await rejectedCodes(runtime.start())).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_BINDING_CAPABILITY_UNSUPPORTED", "HOLQA_BINDING_CAPABILITY_UNSUPPORTED"]);
  });

  it("lets in-flight invocations finish within the grace period", async () => {
    const gate = latch();
    const app = application([apiResource("api")]);
    const runtime = runtimeOf({ app, handlers: [routeHandler("slow", "api", "GET", "/slow", async () => {
      await gate.promise;
      return new Response("finished");
    })] });
    await runtime.start();
    const pending = runtime.fetch(new Request("http://localhost/api/slow"));
    await Bun.sleep(1);
    const stopped = runtime.stop({ graceMs: 1_000 });
    expect(runtime.state).toBe("stopping");
    const rejected = await runtime.fetch(new Request("http://localhost/api/slow"));
    expect(rejected.status).toBe(503);
    gate.release();
    expect(await (await pending).text()).toBe("finished");
    await stopped;
    expect(runtime.state).toBe("stopped");
  });

  it("cancels invocations that outlive the grace period", async () => {
    const app = application([apiResource("api")]);
    let aborted = false;
    const runtime = runtimeOf({ app, handlers: [routeHandler("stuck", "api", "GET", "/stuck", async (_input, context) => new Promise<Response>((resolve) => {
      context.signal.addEventListener("abort", () => {
        aborted = true;
        resolve(new Response("too late"));
      });
    }))] });
    await runtime.start();
    const pending = runtime.fetch(new Request("http://localhost/api/stuck"));
    await Bun.sleep(1);
    await runtime.stop({ graceMs: 5, forceMs: 50 });
    const response = await pending;
    expect(response.status).toBe(503);
    expect(((await response.json()) as { readonly error: { readonly code: string } }).error.code).toBe("HOLQA_INVOCATION_CANCELLED");
    expect(aborted).toBe(true);
  });

  it("lets invocations still waiting for a slot finish before stop resolves", async () => {
    const gate = latch();
    const entered = latch();
    const events: string[] = [];
    const app = application([apiResource("api")]);
    const runtime = runtimeOf({ app, limits: { concurrency: 1, queue: 5 }, handlers: [routeHandler("work", "api", "GET", "/work/:name", async ({ params: { name } }) => {
      events.push(`start ${name} ${runtime.state}`);
      if (name === "a") {
        entered.release();
        await gate.promise;
      }
      return new Response(name);
    })] });
    await runtime.start();
    const first = runtime.fetch(new Request("http://localhost/api/work/a"));
    await entered.promise;
    const queued = runtime.fetch(new Request("http://localhost/api/work/b"));
    const stopped = runtime.stop({ graceMs: 1_000 }).then(() => events.push("stopped"));
    gate.release();
    expect(await Promise.all([first, queued].map(async response => (await response).text()))).toEqual(["a", "b"]);
    await stopped;
    expect(events).toEqual(["start a running", "start b stopping", "stopped"]);
  });

  it("stays stopped when stop is called while it is still starting", async () => {
    const slow = { "~standard": { version: 1 as const, vendor: "test", validate: async (value: unknown) => {
      await Bun.sleep(5);
      return { value };
    } } };
    const app = application([apiResource("api")], [configEntry("REGION", slow, { defaultValue: "eu" })]);
    const runtime = runtimeOf({ app, handlers: [] });
    const starting = runtime.start();
    await runtime.stop();
    expect(await rejectedCodes(starting)).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_RUNTIME_NOT_RUNNING"]);
    expect(runtime.state).toBe("stopped");
    const next = runtimeOf({ app, handlers: [] });
    await next.start();
    await next.stop();
  });

  it("keeps scoped values usable while in-flight invocations drain", async () => {
    const gate = latch();
    const entered = latch();
    const store = { name: "store", create: () => "value" };
    const app = application([apiResource("api")]);
    const runtime = runtimeOf({ app, handlers: [routeHandler("late", "api", "GET", "/late", async (_input, context) => {
      entered.release();
      await gate.promise;
      return new Response(await context.scope!.use(store));
    })] });
    await runtime.start();
    const pending = runtime.fetch(new Request("http://localhost/api/late"));
    await entered.promise;
    const stopped = runtime.stop({ graceMs: 1_000 });
    gate.release();
    expect(await (await pending).text()).toBe("value");
    await stopped;
  });

  it("shares one stop between concurrent callers", async () => {
    const runtime = runtimeOf({ app: application([apiResource("api")]), handlers: [] });
    await runtime.start();
    const first = runtime.stop();
    expect(runtime.stop()).toBe(first);
    await first;
  });

  it("logs start, every invocation with its identifiers, and stop", async () => {
    const { sink, entries } = recordingSink();
    const runtime = runtimeOf({ app: application([apiResource("api")]), handlers: [routeHandler("hello", "api", "GET", "/hello", (_input, context) => {
      context.log.info("greeting", { name: "ada", level: "spoofed" });
      return new Response("hi");
    })], log: sink, clock: () => new Date(0) });
    await runtime.start();
    await runtime.fetch(new Request("http://localhost/api/hello", { headers: { "x-correlation-id": "req-42" } }));
    await runtime.stop();
    expect(entries.map(entry => entry.message)).toEqual(["runtime started", "greeting", "invocation completed", "runtime stopped"]);
    expect(entries[1]).toEqual({ level: "info", time: "1970-01-01T00:00:00.000Z", message: "greeting", application: "shop", handlerId: "hello", invocationId: "inv-1", correlationId: "req-42", triggerKind: "http.route", resourceId: "api", method: "GET", path: "/api/hello", name: "ada" });
    expect(entries[2]).toMatchObject({ outcome: "ok", handlerId: "hello", invocationId: "inv-1" });
  });
});

describe("invocations", () => {
  it("keeps invocation state independent across concurrent requests", async () => {
    const gates = [latch(), latch(), latch()];
    const app = application([apiResource("api")]);
    const runtime = runtimeOf({ app, handlers: [routeHandler("echo", "api", "GET", "/echo/:value", async ({ params: { value } }, context) => {
      const local = { value, invocationId: context.invocationId };
      await gates[Number(value)]!.promise;
      return Response.json(local);
    })] });
    await runtime.start();
    const responses = [0, 1, 2].map(index => runtime.fetch(new Request(`http://localhost/api/echo/${index}`)));
    await Bun.sleep(1);
    expect(runtime.stats().running).toBe(3);
    gates[2]!.release();
    gates[0]!.release();
    gates[1]!.release();
    const bodies = await Promise.all(responses.map(async response => (await response).json()));
    expect(bodies).toEqual([{ value: "0", invocationId: "inv-1" }, { value: "1", invocationId: "inv-2" }, { value: "2", invocationId: "inv-3" }]);
    await runtime.stop();
  });

  it("enforces the concurrency limit and rejects work beyond the wait queue", async () => {
    const gate = latch();
    let active = 0;
    let peak = 0;
    const app = application([apiResource("api")]);
    const runtime = runtimeOf({ app, limits: { concurrency: 2, queue: 1 }, handlers: [routeHandler("work", "api", "GET", "/work", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return new Response("done");
    })] });
    await runtime.start();
    const accepted = [0, 1, 2].map(() => runtime.fetch(new Request("http://localhost/api/work")));
    await Bun.sleep(1);
    const overloaded = await runtime.fetch(new Request("http://localhost/api/work"));
    expect(overloaded.status).toBe(503);
    expect(overloaded.headers.get("retry-after")).toBe("1");
    expect(((await overloaded.json()) as { readonly error: { readonly code: string } }).error.code).toBe("HOLQA_RUNTIME_OVERLOADED");
    expect(runtime.stats()).toMatchObject({ running: 2, waiting: 1 });
    gate.release();
    expect((await Promise.all(accepted)).map(response => response.status)).toEqual([200, 200, 200]);
    expect(peak).toBe(2);
    await runtime.stop();
  });

  it("times out an invocation, aborts its signal and keeps its slot until the code finishes", async () => {
    const gate = latch();
    let sawAbort = false;
    const app = application([apiResource("api")]);
    const runtime = runtimeOf({ app, limits: { concurrency: 1, timeoutMs: 10 }, handlers: [routeHandler("ignores", "api", "GET", "/ignores", async (_input, context) => {
      context.signal.addEventListener("abort", () => {
        sawAbort = true;
      });
      await gate.promise;
      return new Response("late");
    })] });
    await runtime.start();
    const response = await runtime.fetch(new Request("http://localhost/api/ignores"));
    expect(response.status).toBe(504);
    expect(((await response.json()) as { readonly error: { readonly code: string } }).error.code).toBe("HOLQA_INVOCATION_TIMEOUT");
    expect(sawAbort).toBe(true);
    expect(runtime.stats()).toMatchObject({ running: 1, orphaned: 1 });
    const blocked = await runtime.invoke({ handlerId: "ignores", timeoutMs: 5 });
    expect(!blocked.ok && blocked.failure.code).toBe("HOLQA_INVOCATION_TIMEOUT");
    gate.release();
    await Bun.sleep(1);
    expect(runtime.stats()).toMatchObject({ running: 0, orphaned: 0 });
    await runtime.stop();
  });

  it("accepts an unlimited time limit and rejects invalid ones", async () => {
    const app = application([apiResource("api")]);
    const runtime = runtimeOf({ app, limits: { timeoutMs: Number.POSITIVE_INFINITY }, handlers: [routeHandler("slow", "api", "GET", "/slow", async () => {
      await Bun.sleep(5);
      return new Response("ok");
    })] });
    await runtime.start();
    expect((await runtime.fetch(new Request("http://localhost/api/slow"))).status).toBe(200);
    const huge = await runtime.invoke({ handlerId: "slow", input: { request: new Request("http://localhost/api/slow"), params: {} }, timeoutMs: 2 ** 40 });
    expect(huge.ok).toBe(true);
    for (const timeoutMs of [0, -1, Number.NaN]) {
      const outcome = await runtime.invoke({ handlerId: "slow", timeoutMs });
      expect(!outcome.ok && [outcome.failure.code, outcome.failure.status]).toEqual(["HOLQA_INPUT_INVALID", 400]);
    }
    await runtime.stop();
  });

  it("checks the metadata of manual invocations against the trigger kind", async () => {
    const app = application([scheduleResource("nightly")]);
    const runtime = runtimeOf({ app, manualTriggers: true, binding: scheduleBinding, handlers: [scheduleHandler("nightly.run", "nightly", context => context.metadata.scheduledTime)] });
    await runtime.start();
    const missing = await runtime.invoke({ handlerId: "nightly.run" });
    expect(!missing.ok && missing.failure.code).toBe("HOLQA_INPUT_INVALID");
    expect(await runtime.invoke({ handlerId: "nightly.run", metadata: tick })).toMatchObject({ ok: true, value: tick.scheduledTime });
    await runtime.stop();
  });

  it("limits a handler to its own concurrency without holding environment-wide slots while it waits", async () => {
    const gate = latch();
    let active = 0;
    let peak = 0;
    const queue = queueResource("orders");
    const consumer = described({
      protocol: 1,
      type: "handler",
      definition: { id: id("orders.process"), trigger: { kind: "queue.message", resource: { kind: "queue", id: id("orders") }, options: { concurrency: 1 } } },
      schemas: { message: anySchema },
      invoke: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return undefined;
      }
    } as HandlerDescriptor);
    const binding: RuntimeBinding = { name: "test", capabilities: { "queue": { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true }, "http.api": {} }, drivers: { queue: () => ({ send: async () => ({ messageId: "m-1" }) }) }, config: () => undefined };
    const app = application([apiResource("api"), queue]);
    const runtime = runtimeOf({ app, manualTriggers: true, binding, limits: { concurrency: 2 }, handlers: [consumer, routeHandler("ping", "api", "GET", "/ping")] });
    await runtime.start();
    const deliveries = [1, 2, 3].map(attempt => runtime.invoke({ handlerId: "orders.process", metadata: { attempt, messageId: `m${attempt}` } }));
    await Bun.sleep(1);
    expect((await runtime.fetch(new Request("http://localhost/api/ping"))).status).toBe(200);
    gate.release();
    expect((await Promise.all(deliveries)).every(outcome => outcome.ok)).toBe(true);
    expect(peak).toBe(1);
    await runtime.stop();
  });

  it("cancels an invocation when its caller's signal aborts", async () => {
    const app = application([scheduleResource("nightly")]);
    let started = 0;
    const runtime = runtimeOf({ app, manualTriggers: true, handlers: [scheduleHandler("nightly.run", "nightly", async context => new Promise((resolve) => {
      started += 1;
      context.signal.addEventListener("abort", () => resolve("stopped"));
    }))], binding: scheduleBinding });
    await runtime.start();
    const caller = new AbortController();
    const pending = runtime.invoke({ handlerId: "nightly.run", metadata: tick, signal: caller.signal });
    await Bun.sleep(1);
    expect(started).toBe(1);
    caller.abort();
    const outcome = await pending;
    expect(!outcome.ok && outcome.failure.code).toBe("HOLQA_INVOCATION_CANCELLED");
    const already = await runtime.invoke({ handlerId: "nightly.run", metadata: tick, signal: AbortSignal.abort() });
    expect(!already.ok && already.failure.code).toBe("HOLQA_INVOCATION_CANCELLED");
    const raced = new AbortController();
    const abortedWhileWaiting = runtime.invoke({ handlerId: "nightly.run", metadata: tick, signal: raced.signal });
    raced.abort();
    const racedOutcome = await abortedWhileWaiting;
    expect(!racedOutcome.ok && racedOutcome.failure.code).toBe("HOLQA_INVOCATION_CANCELLED");
    expect(started).toBe(1);
    await runtime.stop();
  });

  it("normalizes handler errors without exposing their messages, and reports unknown handlers", async () => {
    const { sink, entries } = recordingSink();
    const app = application([apiResource("api")]);
    const runtime = runtimeOf({ app, log: sink, handlers: [routeHandler("fails", "api", "GET", "/fails", () => {
      throw new Error("database password is hunter2");
    })] });
    await runtime.start();
    const outcome = await runtime.invoke({ handlerId: "fails" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toMatchObject({ code: "HOLQA_HANDLER_FAILED", status: 500 });
      expect(outcome.failure.message).not.toContain("hunter2");
    }
    expect(JSON.stringify(entries.find(entry => entry.message === "invocation failed"))).toContain("hunter2");
    const unknown = await runtime.invoke({ handlerId: "missing" });
    expect(!unknown.ok && [unknown.failure.code, unknown.failure.status]).toEqual(["HOLQA_HANDLER_NOT_FOUND", 404]);
    await runtime.stop();
  });

  it("creates scoped values once per runtime, shares them between invocations, and disposes of them in reverse order", async () => {
    const events: string[] = [];
    let pools = 0;
    const pool = { name: "pool", create: async () => {
      events.push("create pool");
      pools += 1;
      return { id: pools };
    }, dispose: () => {
      events.push("dispose pool");
    } };
    const cache = { name: "cache", create: () => {
      events.push("create cache");
      return new Map<string, string>();
    }, dispose: () => {
      events.push("dispose cache");
      throw new Error("cache disposal failed");
    } };
    const { sink, entries } = recordingSink();
    const app = application([apiResource("api")]);
    const handlers = [routeHandler("use", "api", "GET", "/use", async (_input, context) => {
      const [first, second] = await Promise.all([context.scope!.use(pool), context.scope!.use(pool)]);
      await context.scope!.use(cache);
      return Response.json({ same: first === second, id: first.id });
    })];
    const runtime = runtimeOf({ app, handlers, log: sink });
    await runtime.start();
    const a = await (await runtime.fetch(new Request("http://localhost/api/use"))).json() as { readonly same: boolean; readonly id: number };
    const b = await (await runtime.fetch(new Request("http://localhost/api/use"))).json() as { readonly same: boolean; readonly id: number };
    expect(a.same).toBe(true);
    expect(a.id).toBe(b.id);
    await runtime.stop();
    expect(events).toEqual(["create pool", "create cache", "dispose cache", "dispose pool"]);
    expect(entries.some(({ message, scoped }) => message === "disposing of a scoped value failed" && scoped === "cache")).toBe(true);

    const restarted = runtimeOf({ app: application([apiResource("api")]), handlers });
    await restarted.start();
    const c = await (await restarted.fetch(new Request("http://localhost/api/use"))).json() as { readonly id: number };
    expect(c.id).not.toBe(a.id);
    await restarted.stop();
  });

  it("does not cache a failed creation of a scoped value", async () => {
    let attempts = 0;
    const flaky = { name: "flaky", create: () => {
      attempts += 1;
      if (attempts === 1)
        throw new Error("not yet");
      return attempts;
    } };
    const app = application([apiResource("api")]);
    const runtime = runtimeOf({ app, handlers: [routeHandler("use", "api", "GET", "/use", async (_input, context) => Response.json(await context.scope!.use(flaky)))] });
    await runtime.start();
    expect((await runtime.fetch(new Request("http://localhost/api/use"))).status).toBe(500);
    expect(await (await runtime.fetch(new Request("http://localhost/api/use"))).json()).toBe(2);
    await runtime.stop();
  });
});