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

import { latch } from "./fixtures/basic/latches";
import {
  basicEnv,
  copyFixture,
  removeFixtureCopies,
  setFixtureVersion
} from "./support/fixture";
import {
  counter,
  rejectionCode,
  waitFor
} from "./support/wait";

const started: Runtime[] = [];
let keys = 0;

/**
 * Creates and loads a runtime over a fresh copy of the basic fixture.
 *
 * @param strategy - The reload strategy.
 * @param drainMs - How long replaced generations may drain.
 * @returns The fixture copy and the loaded runtime.
 */
async function start(strategy: ReloadStrategy, drainMs = 60_000): Promise<{ readonly root: string; readonly runtime: Runtime }> {
  const root = copyFixture("basic");
  const runtime = createRuntime({ root, strategy, env: basicEnv, drainMs });
  started.push(runtime);
  expect((await runtime.load()).ok).toBe(true);
  return { root, runtime };
}

/**
 * Returns a latch key that no other test uses.
 *
 * @param label - A readable prefix.
 * @returns The unique key.
 */
function key(label: string): string {
  keys += 1;
  return `${label}-${String(process.pid)}-${String(keys)}`;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map(async runtime => runtime.dispose({ graceMs: 0 })));
});

afterAll(() => removeFixtureCopies());

describe("concurrency limits (in-process strategy, latch-controlled)", () => {
  it("never runs more consumers than the declared concurrency", async () => {
    const { runtime } = await start("in-process");
    const batch = Array.from({ length: 5 }, () => key("limit"));
    for (const item of batch)
      runtime.enqueue("gated", { key: item, ignoreAbort: false });
    await waitFor(() => runtime.stats().inFlight["gated-consumer"] === 2 && runtime.stats().waiting["gated-consumer"] === 3);
    for (const item of batch)
      latch(item).release();
    await runtime.idle();
    expect(runtime.stats().peakConcurrency["gated-consumer"]).toBe(2);
    expect(runtime.queue("gated")).toMatchObject({ delivered: 5, pending: 0 });
  });

  it("cancels an invocation that is still waiting for a slot without starting it", async () => {
    const { runtime } = await start("in-process");
    const [first, second, third] = [key("wait"), key("wait"), key("wait")];
    const running = [first, second].map(async item => runtime.invoke("gated-consumer", { key: item, ignoreAbort: false }));
    await Promise.all([latch(first).started, latch(second).started]);
    const controller = new AbortController();
    const waiting = runtime.invoke("gated-consumer", { key: third, ignoreAbort: false }, { signal: controller.signal });
    await waitFor(() => runtime.stats().waiting["gated-consumer"] === 1);
    controller.abort();
    expect(await rejectionCode(waiting)).toBe("HOLQA_INVOCATION_CANCELLED");
    expect(latch(third).startedWith).toBeUndefined();
    latch(first).release();
    latch(second).release();
    await Promise.all(running);
  });

  it("keeps an orphaned handler's slot until its code actually finishes", async () => {
    const { runtime } = await start("in-process");
    const [first, second, third] = [key("orphan"), key("orphan"), key("orphan")];
    const controllers = [new AbortController(), new AbortController()];
    const ignoring = [first, second].map(async (item, index) => runtime.invoke("gated-consumer", { key: item, ignoreAbort: true }, { signal: controllers[index]!.signal }));
    await Promise.all([latch(first).started, latch(second).started]);
    for (const controller of controllers)
      controller.abort();
    expect(await Promise.all(ignoring.map(rejectionCode))).toEqual(["HOLQA_INVOCATION_CANCELLED", "HOLQA_INVOCATION_CANCELLED"]);
    expect(runtime.stats().orphaned).toBe(2);

    const next = runtime.invoke("gated-consumer", { key: third, ignoreAbort: false });
    await waitFor(() => runtime.stats().waiting["gated-consumer"] === 1);
    expect(latch(third).startedWith).toBeUndefined();
    latch(first).release();
    await latch(third).started;
    latch(second).release();
    latch(third).release();
    await next;
    await waitFor(() => runtime.stats().orphaned === 0);
    expect(runtime.stats().peakConcurrency["gated-consumer"]).toBe(2);
  });
});

describe("stress", () => {
  it("keeps runtime invariants under concurrent invocations, reloads and cancellations (in-process)", async () => {
    const { root, runtime } = await start("in-process");
    const calls: { readonly key: string; readonly promise: Promise<unknown> }[] = [];
    const settlements: number[] = [];
    const violations: string[] = [];
    let generation = 1;

    for (let index = 0; index < 48; index++) {
      const item = key("stress");
      const controller = new AbortController();
      const promise = runtime.invoke("gated-consumer", { key: item, ignoreAbort: index % 7 === 3 }, { signal: controller.signal });
      settlements.push(0);
      void promise.then(() => settlements[index]! += 1, () => settlements[index]! += 1);
      void latch(item).started.then(() => {
        const startedIn = latch(item).startedWith?.version;
        const summary = runtime.stats().generations.find(candidate => `v${String(candidate.number)}` === startedIn);
        if (summary?.status === "disposed")
          violations.push(`${item} started in disposed generation ${String(summary.number)}`);
      });
      calls.push({ key: item, promise });

      if (index % 5 === 4)
        controller.abort();
      if (index % 3 === 0)
        latch(calls[Math.floor(index / 2)]!.key).release();
      if (index % 8 === 7) {
        generation += 1;
        setFixtureVersion(root, `v${String(generation)}`);
        expect(await runtime.reload()).toEqual({ ok: true, value: generation });
      }
      const stats = runtime.stats();
      if ((stats.inFlight["gated-consumer"] ?? 0) > 2)
        violations.push(`concurrency exceeded at ${String(index)}`);
    }

    for (const call of calls)
      latch(call.key).release();
    const outcomes = await Promise.allSettled(calls.map(async call => call.promise));
    await runtime.retired();
    await waitFor(() => runtime.stats().orphaned === 0);

    expect(violations).toEqual([]);
    expect(settlements.every(count => count === 1)).toBe(true);
    expect(outcomes.filter(outcome => outcome.status === "rejected").length).toBeGreaterThan(0);
    const stats = runtime.stats();
    expect(stats.inFlight["gated-consumer"]).toBe(0);
    expect(stats.waiting["gated-consumer"]).toBe(0);
    expect(stats.peakConcurrency["gated-consumer"]).toBe(2);
    expect(stats.completed + stats.failed + stats.cancelled).toBe(calls.length);
    const expectedStatuses: string[] = [...Array.from<string>({ length: generation - 1 }).fill("disposed"), "active"];
    expect(stats.generations.map(summary => summary.status as string)).toEqual(expectedStatuses);

    // Module state is isolated per generation: one evaluation per version, never shared.
    const evaluations = new Map<string, Set<number>>();
    for (const call of calls) {
      const state = latch(call.key).startedWith;
      if (state !== undefined)
        evaluations.set(state.version, (evaluations.get(state.version) ?? new Set()).add(state.evaluation));
    }
    expect([...evaluations.values()].every(values => values.size === 1)).toBe(true);
    expect(new Set([...evaluations.values()].flatMap(values => [...values])).size).toBe(evaluations.size);
  });

  it("keeps runtime invariants under concurrent invocations, reloads and timeouts (worker)", async () => {
    const { root, runtime } = await start("worker", 2000);
    const promises: Promise<PromiseSettledResult<unknown>>[] = [];
    let generation = 1;
    for (let index = 0; index < 40; index++) {
      // Observe each outcome immediately so that early rejections are never unhandled.
      promises.push(runtime.invoke("sleep", { body: { ms: (index * 7) % 25, ignoreAbort: index % 6 === 0 } }, index % 4 === 0 ? { timeoutMs: 5 } : {})
        .then(value => ({ status: "fulfilled" as const, value }), (reason: unknown) => ({ status: "rejected" as const, reason })));
      if (index % 10 === 9) {
        generation += 1;
        setFixtureVersion(root, `v${String(generation)}`);
        expect(await runtime.reload()).toEqual({ ok: true, value: generation });
      }
    }
    const outcomes = await Promise.all(promises);
    await runtime.retired();
    await waitFor(() => runtime.stats().orphaned === 0);
    const versions = new Set(Array.from({ length: generation }, (_unused, index) => `v${String(index + 1)}`));
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled")
        expect(versions.has((outcome.value as { body: { version: string } }).body.version)).toBe(true);
      else
        expect(await rejectionCode(Promise.reject(outcome.reason))).toBe("HOLQA_INVOCATION_CANCELLED");
    }
    const stats = runtime.stats();
    expect(counter(stats.inFlight, "sleep")).toBe(0);
    expect(stats.completed + stats.failed + stats.cancelled).toBe(promises.length);
    const expectedStatuses: string[] = [...Array.from<string>({ length: generation - 1 }).fill("disposed"), "active"];
    expect(stats.generations.map(summary => summary.status as string)).toEqual(expectedStatuses);
  });
});