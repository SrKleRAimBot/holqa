import type { TestAppOptions } from "@/app/create-test-app";

import { diagnosticsOf } from "@holqa/core";
import loops, {
  charges,
  flaky,
  handlers
} from "@test/fixtures/loops";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from "bun:test";

import { createTestApp } from "@/app/create-test-app";

/** Test apps to dispose after each test. */
const disposals: Array<() => Promise<void>> = [];

beforeEach(() => {
  charges.length = 0;
  flaky.clear();
});

afterEach(async () => {
  for (const dispose of disposals.splice(0))
    await dispose();
});

/**
 * Creates and registers a test app of the fixture.
 *
 * @param options - Settings beyond the application and handlers.
 * @returns The started app.
 */
async function start(options: Partial<TestAppOptions> = {}): Promise<Awaited<ReturnType<typeof createTestApp>>> {
  const app = await createTestApp({ app: loops, handlers, ...options });
  disposals.push(app.dispose);
  return app;
}

describe("event safety", () => {
  it("stops a runaway self-cycle at the default depth with a terminal outcome", async () => {
    const app = await start();
    await app.send("loop", { id: "a", step: "0" });
    await app.drain();
    const runs = app.invocations({ handlerId: "loop.run" });
    // Depths 0 to 16 run; the send from depth 16 would create depth 17.
    expect(runs).toHaveLength(17);
    expect(runs.map(record => record.depth)).toEqual(Array.from({ length: 17 }, (_, depth) => depth));
    expect(runs.at(-1)).toMatchObject({ outcome: "failed", code: "HOLQA_EVENT_DEPTH_EXCEEDED", blocked: "HOLQA_EVENT_DEPTH_EXCEEDED" });
    expect(app.deadLetters("loop")).toMatchObject([{ attempts: 1, lastError: { code: "HOLQA_EVENT_DEPTH_EXCEEDED" }, trace: { depth: 16 } }]);
    expect(app.lineage(runs.at(-1)!.invocationId).map(record => record.depth)).toEqual(runs.map(record => record.depth));
  });

  it("ends a delivery terminally even when the handler replaces the guard's error", async () => {
    const app = await start({ events: { maxDepth: 3 } });
    await app.send("wrapped", { id: "w", step: "0" });
    await app.drain();
    const runs = app.invocations({ handlerId: "wrapped.run" });
    expect(runs.map(record => [record.depth, record.outcome])).toEqual([[0, "ok"], [1, "ok"], [2, "ok"], [3, "failed"]]);
    expect(runs.at(-1)).toMatchObject({ code: "HOLQA_HANDLER_FAILED", blocked: "HOLQA_EVENT_DEPTH_EXCEEDED" });
    expect(app.deadLetters("wrapped")).toMatchObject([{ attempts: 1, lastError: { code: "HOLQA_EVENT_DEPTH_EXCEEDED" } }]);
  });

  it("bounds a branching storm with a per-operation budget that independent operations do not share", async () => {
    const app = await start({ events: { maxEventsPerOperation: 10 } });
    const first = await app.send("fanout", { id: "first", step: "0" });
    const second = await app.send("fanout", { id: "second", step: "0" });
    await app.drain();
    for (const { messageId } of [first, second]) {
      const operation = app.operation(messageId);
      const published = operation.reduce((total, record) => total + record.emitted.length, 0);
      expect(published).toBe(10);
      expect(operation.filter(record => record.blocked !== undefined).every(record => record.code === "HOLQA_EXECUTION_BUDGET_EXCEEDED")).toBe(true);
    }
    expect(new Set(app.deadLetters("fanout").map(message => message.lastError?.code))).toEqual(new Set(["HOLQA_EXECUTION_BUDGET_EXCEEDED"]));
  });

  it("gives requests that share a caller's correlation identifier separate operations and budgets", async () => {
    const app = await start({ events: { maxEventsPerOperation: 4 } });
    /**
     * Starts a fan-out over HTTP with a fixed correlation header.
     *
     * @param id - The fan-out's identifier.
     * @returns The response status.
     */
    const post = async (id: string): Promise<number> => (await app.fetch("/api/start", { method: "POST", headers: { "content-type": "application/json", "x-correlation-id": "shared" }, body: JSON.stringify({ id }) })).status;
    expect([await post("x"), await post("y")]).toEqual([202, 202]);
    await app.drain();
    const roots = app.invocations({ handlerId: "loops.start" });
    expect(roots.map(record => record.correlationId)).toEqual(["shared", "shared"]);
    expect(roots[0]!.rootId).not.toBe(roots[1]!.rootId);
    for (const root of roots)
      expect(app.operation(root.rootId).reduce((total, record) => total + record.emitted.length, 0)).toBe(4);
  });

  it("permits an intentional, terminating cycle while the guards stay active", async () => {
    const app = await start({ events: { maxDepth: 8 } });
    await app.send("retry", { id: "r", step: "0" });
    await app.drain();
    expect(app.invocations({ handlerId: "retry.run" }).map(record => [record.depth, record.outcome])).toEqual([[0, "ok"], [1, "ok"], [2, "ok"], [3, "ok"], [4, "ok"], [5, "ok"]]);
    expect(app.deadLetters("retry")).toEqual([]);
  });

  it("still stops an allowed cycle that outgrows the depth limit", async () => {
    const app = await start({ events: { maxDepth: 3 } });
    await app.send("retry", { id: "r", step: "0" });
    await app.drain();
    expect(app.deadLetters("retry")).toMatchObject([{ lastError: { code: "HOLQA_EVENT_DEPTH_EXCEEDED" } }]);
  });

  it("refuses publications beyond a handler's limit and keeps the ones before it", async () => {
    const app = await start();
    await app.send("burst", { id: "b", step: "0" });
    await app.drain();
    expect(app.invocations({ handlerId: "sink.run" })).toHaveLength(2);
    expect(app.deadLetters("burst")).toMatchObject([{ attempts: 1, lastError: { code: "HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED" } }]);
  });

  it("does not deliver events older than the age limit", async () => {
    const app = await start({ events: { maxEventAgeMs: 2_000 } });
    await app.send("sink", { id: "late", step: "0" }, { delaySeconds: 5 });
    await app.send("sink", { id: "soon", step: "0" }, { delaySeconds: 1 });
    await app.drain();
    expect(app.invocations({ handlerId: "sink.run" })).toHaveLength(1);
    expect(app.deadLetters("sink")).toMatchObject([{ attempts: 1, lastError: { code: "HOLQA_EVENT_AGE_EXCEEDED" } }]);
  });

  it("fails with a budget-exceeded explanation instead of running an unbounded storm", async () => {
    const app = await start({ maxInvocations: 40, events: { maxDepth: 1_000 } });
    await app.send("fanout", { id: "storm", step: "0" });
    let caught: unknown;
    try {
      await app.flush();
    } catch (error) {
      caught = error;
    }
    const [diagnostic] = diagnosticsOf(caught);
    expect(diagnostic).toMatchObject({ code: "HOLQA_SIMULATION_BUDGET_EXCEEDED", details: { maxInvocations: 40, busiest: [{ handler: "fanout.run" }] } });
    expect(diagnostic!.message).toContain("Deepest chain");
  });

  it("reports a spent simulation budget from drain as well", async () => {
    const app = await start({ maxInvocations: 5, events: { maxDepth: 1_000 } });
    await app.send("loop", { id: "l", step: "0" });
    const codes = await app.drain().then(() => [], (error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
    expect(codes).toEqual(["HOLQA_SIMULATION_BUDGET_EXCEEDED"]);
  });

  it("suppresses duplicate deliveries but repeats side effects of failed attempts, as documented", async () => {
    const app = await start();
    const { messageId } = await app.send("payments", { id: "p-1", step: "0" });
    await app.flush();
    expect(app.duplicate("payments", messageId)).toBe(true);
    await app.send("payments", { id: "p-1", step: "0" });
    await app.flush();
    expect(charges).toEqual(["p-1#1"]);
    expect(app.logs.filter(entry => entry.message === "duplicate delivery skipped; its idempotency key already completed")).toHaveLength(2);

    flaky.add("p-2");
    await app.send("payments", { id: "p-2", step: "0" });
    await app.drain();
    expect(charges).toEqual(["p-1#1", "p-2#1", "p-2#2"]);
    expect(app.invocations({ handlerId: "payments.charge" }).filter(record => record.outcome === "failed")).toHaveLength(1);
  });
});