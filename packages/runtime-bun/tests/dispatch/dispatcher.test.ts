import type { RegisteredHandler } from "@/dispatch/dispatcher";

import {
  application,
  latch,
  scheduleHandler,
  scheduleResource,
  sequentialIds
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import { Dispatcher } from "@/dispatch/dispatcher";
import { StructuredLogger } from "@/logging/log";
import { RuntimeScope } from "@/runtime/application-scope";

/**
 * Creates a dispatcher for schedule handlers.
 *
 * @param handle - The handler body.
 * @param options - Concurrency and queue limits.
 * @param options.concurrency - Concurrent executions.
 * @param options.queue - Waiting invocations.
 * @returns A dispatcher that accepts invocations of `nightly.run`.
 */
function dispatcherFor(handle: (context: { readonly signal: AbortSignal }) => Promise<unknown>, options: { readonly concurrency?: number; readonly queue?: number } = {}): Dispatcher {
  application([scheduleResource("nightly")]);
  const { definition, invoke, schemas } = scheduleHandler("nightly.run", "nightly", handle)["~holqa"];
  const logger = new StructuredLogger(() => {});
  return new Dispatcher({
    handlers: new Map<string, RegisteredHandler>([["nightly.run", { definition, schemas, invoke: invoke as RegisteredHandler["invoke"] }]]),
    concurrency: options.concurrency ?? 4,
    queueLimit: options.queue ?? 4,
    timeoutMs: 1_000,
    logger,
    createId: sequentialIds(),
    now: () => 0,
    scope: new RuntimeScope(logger).scope,
    accepting: () => true
  });
}

/** Metadata of a scheduled run. */
const metadata = { scheduledTime: "2026-10-18T03:00:00Z" };

describe("Dispatcher", () => {
  it("becomes idle only when no invocation is running or waiting", async () => {
    const gate = latch();
    const dispatcher = dispatcherFor(async () => gate.promise, { concurrency: 1 });
    const running = dispatcher.dispatch({ handlerId: "nightly.run", metadata });
    const waiting = dispatcher.dispatch({ handlerId: "nightly.run", metadata });
    await Bun.sleep(0);
    expect(dispatcher.stats()).toMatchObject({ running: 1, waiting: 1 });
    expect(await dispatcher.idle(5)).toBe(false);
    gate.release();
    expect(await dispatcher.idle(1_000)).toBe(true);
    expect((await Promise.all([running, waiting])).map(outcome => outcome.ok)).toEqual([true, true]);
    expect(dispatcher.stats()).toMatchObject({ running: 0, waiting: 0, succeeded: 2, failed: 0, peakConcurrency: 1 });
  });

  it("cancels running and waiting invocations with abortAll", async () => {
    const dispatcher = dispatcherFor(async () => new Promise(() => {}), { concurrency: 1 });
    const outcomes = [dispatcher.dispatch({ handlerId: "nightly.run", metadata }), dispatcher.dispatch({ handlerId: "nightly.run", metadata })];
    await Bun.sleep(0);
    dispatcher.abortAll();
    const settled = await Promise.all(outcomes);
    expect(settled.map(outcome => !outcome.ok && outcome.failure.code)).toEqual(["HOLQA_INVOCATION_CANCELLED", "HOLQA_INVOCATION_CANCELLED"]);
    expect(dispatcher.stats().orphaned).toBe(1);
  });

  it("classifies a handler that rethrows its abort reason as the runtime's abort", async () => {
    const dispatcher = dispatcherFor(async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    }));
    const outcome = await dispatcher.dispatch({ handlerId: "nightly.run", metadata, timeoutMs: 5 });
    expect(!outcome.ok && outcome.failure.code).toBe("HOLQA_INVOCATION_TIMEOUT");
  });
});