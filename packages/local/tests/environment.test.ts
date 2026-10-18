import type {
  QueueRequirements,
  ResourceDescriptor,
  ResourceDescriptorOf
} from "@holqa/core";
import type { Runtime } from "@holqa/runtime-bun";

import type { LocalEnvironment } from "@/environment";
import { messageEnvelopeFormat } from "@holqa/core";
import {
  createRuntime,
  silentSink
} from "@holqa/runtime-bun";
import {
  application,
  bucketResource,
  consumer,
  objectHandler,
  queueResource,
  scheduleHandler,
  scheduleResource,
  sequentialIds,
  stateDirectory
} from "@test/support/fixtures";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import { ManualClock } from "@/clock";
import { createLocalEnvironment } from "@/environment";

/** Cleanups to run after each test, in reverse order. */
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup();
});

/**
 * Waits until a condition holds, polling every millisecond for at most two seconds.
 *
 * @param condition - The condition to wait for.
 * @returns A promise that settles once the condition holds.
 * @throws {Error} When the condition does not hold in time.
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
 * Starts a runtime on a local environment.
 *
 * @param resources - The application's resources.
 * @param handlers - The handler registrations.
 * @param options - An existing state directory (for restarts) and the clock.
 * @param options.directory - Reuse this state directory.
 * @param options.clock - The clock; a new manual clock when absent.
 * @returns The environment, runtime, clock, directory and the application.
 */
async function start(resources: readonly ResourceDescriptor[], handlers: readonly unknown[], options: { readonly directory?: string; readonly clock?: ManualClock } = {}): Promise<{ readonly env: LocalEnvironment; readonly runtime: Runtime; readonly clock: ManualClock; readonly directory: string; readonly stop: () => Promise<void> }> {
  let directory = options.directory;
  if (directory === undefined) {
    const created = stateDirectory();
    cleanups.push(created.remove);
    directory = created.path;
  }
  const clock = options.clock ?? new ManualClock(Date.parse("2026-10-18T10:00:00.000Z"));
  const app = application(resources);
  const env = await createLocalEnvironment({ app, directory, clock, env: {} });
  const runtime = createRuntime({ app, handlers, binding: env.binding, log: silentSink, createId: sequentialIds("inv-") });
  await runtime.start();
  let stopped = false;
  /** Stops the runtime and closes the environment once. */
  const stop = async (): Promise<void> => {
    if (stopped)
      return;
    stopped = true;
    await runtime.stop({ graceMs: 50, forceMs: 50 });
    env.close();
  };
  cleanups.push(stop);
  return { env, runtime, clock, directory, stop };
}

/**
 * Sends a `{ name }` message through the local queue driver, as a handle's `send` does.
 *
 * @param env - The environment.
 * @param queue - The queue descriptor.
 * @param name - The message's name.
 * @param delaySeconds - A delivery delay.
 * @returns The message identifier.
 */
async function send(env: LocalEnvironment, queue: ResourceDescriptor, name: string, delaySeconds = 0): Promise<string> {
  const { messageId } = await env.binding.drivers.queue!(queue as ResourceDescriptorOf<"queue">).send({ format: messageEnvelopeFormat, schemaVersion: 1, payload: { name } }, delaySeconds === 0 ? {} : { delaySeconds });
  return messageId;
}

/**
 * Builds the `jobs` queue.
 *
 * @param requirements - Delivery requirements.
 * @returns The descriptor.
 */
function jobs(requirements: Partial<QueueRequirements> = {}): ResourceDescriptor {
  return queueResource("jobs", { maxAttempts: 3, backoff: { strategy: "fixed", delaySeconds: 5 }, ...requirements });
}

describe("local queues under the runtime", () => {
  it("retries a failed message after its backoff and acknowledges it once it succeeds", async () => {
    const attempts: number[] = [];
    const { env, clock } = await start([jobs()], [consumer("jobs.run", "jobs", (_message, context) => {
      attempts.push(context.metadata.attempt);
      if (context.metadata.attempt === 1)
        throw new Error("transient");
    })]);
    const messageId = await send(env, jobs(), "a");
    await env.settle();
    expect(attempts).toEqual([1]);
    expect(env.queues.messages("jobs")).toMatchObject([{ messageId, state: "delayed", attempts: 1, lastError: { code: "HOLQA_HANDLER_FAILED" } }]);
    clock.advance(5_000);
    await env.settle();
    expect(attempts).toEqual([1, 2]);
    expect(env.queues.messages("jobs")).toMatchObject([{ messageId, state: "acknowledged", attempts: 2, payload: { name: "a" }, schemaVersion: 1 }]);
  });

  it("dead-letters a message whose attempts are exhausted, and redrives it for inspection and recovery", async () => {
    let healthy = false;
    const seen: string[] = [];
    const { env, clock } = await start([jobs({ maxAttempts: 2 })], [consumer("jobs.run", "jobs", (message) => {
      seen.push((message as { name: string }).name);
      if (!healthy)
        throw new Error("poison");
    })]);
    const messageId = await send(env, jobs(), "poison");
    await env.settle();
    clock.advance(5_000);
    await env.settle();
    expect(env.queues.deadLetters("jobs")).toMatchObject([{ messageId, state: "dead-lettered", attempts: 2, payload: { name: "poison" }, lastError: { code: "HOLQA_HANDLER_FAILED", invocationId: "inv-2" } }]);
    healthy = true;
    expect(env.queues.redrive("jobs", messageId)).toBe(1);
    await env.settle();
    expect(seen).toEqual(["poison", "poison", "poison"]);
    expect(env.queues.deadLetters("jobs")).toEqual([]);
  });

  it("dead-letters messages that fail the contract at once, without invoking the consumer", async () => {
    let calls = 0;
    const { env } = await start([jobs()], [consumer("jobs.run", "jobs", () => calls += 1)]);
    await env.binding.drivers.queue!(jobs() as ResourceDescriptorOf<"queue">).send({ format: messageEnvelopeFormat, schemaVersion: 1, payload: { title: "no name" } }, {});
    await env.settle();
    expect(calls).toBe(0);
    expect(env.queues.deadLetters("jobs")).toMatchObject([{ attempts: 1, lastError: { code: "HOLQA_INPUT_INVALID" } }]);
  });

  it("delivers delayed messages only when the clock reaches their delay", async () => {
    const seen: string[] = [];
    const { env, clock } = await start([jobs()], [consumer("jobs.run", "jobs", message => seen.push((message as { name: string }).name))]);
    await send(env, jobs(), "later", 60);
    await send(env, jobs(), "now");
    await env.settle();
    expect(seen).toEqual(["now"]);
    clock.advance(59_999);
    await env.settle();
    expect(seen).toEqual(["now"]);
    clock.advance(1);
    await env.settle();
    expect(seen).toEqual(["now", "later"]);
  });

  it("simulates duplicate delivery with the same message identifier", async () => {
    const seen: string[] = [];
    const { env } = await start([jobs()], [consumer("jobs.run", "jobs", (_message, context) => seen.push(context.metadata.messageId))]);
    const messageId = await send(env, jobs(), "a");
    await env.settle();
    expect(env.queues.duplicate("jobs", messageId)).toBe(true);
    await env.settle();
    expect(seen).toEqual([messageId, messageId]);
  });

  it("runs at most the consumer's concurrency at once", async () => {
    let active = 0;
    let peak = 0;
    const { env } = await start([jobs()], [consumer("jobs.run", "jobs", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
    }, 2)]);
    for (const name of ["a", "b", "c", "d", "e", "f"])
      await send(env, jobs(), name);
    await env.settle();
    expect(peak).toBe(2);
    expect(env.queues.messages("jobs", ["acknowledged"])).toHaveLength(6);
  });

  it("keeps messages across a restart and redelivers those a stopping runtime released", async () => {
    const attempts: number[] = [];
    const first = await start([jobs()], [consumer("jobs.run", "jobs", async (_message, context) => {
      attempts.push(context.metadata.attempt);
      await new Promise(resolve => context.signal.addEventListener("abort", resolve));
    })]);
    await send(first.env, jobs(), "long");
    await until(() => attempts.length === 1);
    await first.stop();
    const second = await start([jobs()], [consumer("jobs.run", "jobs", (_message, context) => {
      attempts.push(context.metadata.attempt);
    })], { directory: first.directory, clock: first.clock });
    await second.env.settle();
    expect(attempts).toEqual([1, 2]);
    expect(second.env.queues.messages("jobs")).toMatchObject([{ state: "acknowledged", attempts: 2 }]);
  });

  it("refuses to start when a queue requires more than the local binding offers", async () => {
    const app = application([jobs({ maxAttempts: 500 })]);
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    const env = await createLocalEnvironment({ app, directory: directory.path, env: {} });
    cleanups.push(() => env.close());
    const runtime = createRuntime({ app, handlers: [], binding: env.binding, log: silentSink });
    await expect(runtime.start()).rejects.toThrow("HOLQA_BINDING_CAPABILITY_UNSUPPORTED");
  });

  it("rejects values that are not applications and malformed options", async () => {
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    await expect(createLocalEnvironment({ app: { name: "not an app" }, directory: directory.path, env: {} })).rejects.toThrow("HOLQA_APP_INVALID");
    for (const options of [{ queues: { pollIntervalMs: 0 } }, { queues: { defaultMaxAttempts: 1.5 } }, { storage: { signedUrlBase: "not a url" } }, { storage: { maxUploadBytes: -1 } }])
      await expect(createLocalEnvironment({ app: application([jobs()]), directory: directory.path, env: {}, ...options })).rejects.toThrow("HOLQA_DECLARATION_INVALID");
  });

  it("reports work that does not settle in time", async () => {
    const { env } = await start([jobs()], [consumer("jobs.run", "jobs", async (_message, context) => {
      await new Promise(resolve => context.signal.addEventListener("abort", resolve));
    })]);
    await send(env, jobs(), "stuck");
    await expect(env.settle({ timeoutMs: 20 })).rejects.toThrow("HOLQA_INVOCATION_TIMEOUT");
  });
});

describe("local storage events under the runtime", () => {
  it("delivers created and deleted events to their handlers with event identity", async () => {
    const files = bucketResource("files");
    const seen: unknown[] = [];
    const { env } = await start([files], [
      objectHandler("files.created", "files", "bucket.object-created", (object, metadata) => seen.push({ created: object, metadata }), "incoming/"),
      objectHandler("files.deleted", "files", "bucket.object-deleted", object => seen.push({ deleted: object }))
    ]);
    const bucket = env.binding.drivers.bucket!(files as ResourceDescriptorOf<"bucket">);
    await bucket.put("incoming/a.txt", new TextEncoder().encode("abc"), { contentType: "text/plain" });
    await bucket.put("elsewhere/b.txt", new TextEncoder().encode("b"), {});
    await env.settle();
    await bucket.delete("incoming/a.txt");
    await env.settle();
    const eventId = env.storage.events("files")[0]!.event.id;
    expect(seen).toEqual([
      { created: { key: "incoming/a.txt", size: 3, contentType: "text/plain" }, metadata: { eventId, eventTime: "2026-10-18T10:00:00.000Z", attempt: 1 } },
      { deleted: { key: "incoming/a.txt" } }
    ]);
    expect(env.storage.duplicateEvent("files", "files.created", eventId)).toBe(true);
    await env.settle();
    expect(seen).toHaveLength(3);
    expect(seen[2]).toEqual({ created: { key: "incoming/a.txt", size: 3, contentType: "text/plain" }, metadata: { eventId, eventTime: "2026-10-18T10:00:00.000Z", attempt: 1 } });
  });

  it("keeps events for a subscription while its runtime is stopped", async () => {
    const files = bucketResource("files");
    const seen: string[] = [];
    const handler = objectHandler("files.created", "files", "bucket.object-created", object => seen.push((object as { key: string }).key));
    const first = await start([files], [handler]);
    await first.stop();
    const app = application([files]);
    const offline = await createLocalEnvironment({ app, directory: first.directory, clock: first.clock, env: {} });
    await offline.binding.drivers.bucket!(files as ResourceDescriptorOf<"bucket">).put("while-stopped.txt", new TextEncoder().encode("x"), {});
    offline.close();
    const second = await start([files], [handler], { directory: first.directory, clock: first.clock });
    await second.env.settle();
    expect(seen).toEqual(["while-stopped.txt"]);
  });
});

describe("local schedules under the runtime", () => {
  it("runs cron and manual runs through the runtime and skips overlapping runs", async () => {
    const hourly = scheduleResource("hourly", "0 * * * *", "skip");
    const releases: Array<() => void> = [];
    const runs: unknown[] = [];
    const { env, clock } = await start([hourly], [scheduleHandler("hourly.run", "hourly", async (metadata) => {
      runs.push(metadata.trigger);
      await new Promise<void>(resolve => releases.push(resolve));
    })]);
    clock.advance(3_600_000);
    await until(() => releases.length === 1);
    const manual = await env.scheduler.trigger("hourly");
    expect(manual).toMatchObject({ trigger: "manual", status: "skipped", code: "HOLQA_SCHEDULE_RUN_SKIPPED" });
    releases[0]!();
    await env.settle();
    expect(runs).toEqual(["cron"]);
    expect(env.scheduler.runs("hourly").map(run => `${run.trigger}:${run.status}`)).toEqual(["manual:skipped", "cron:succeeded"]);
    const second = env.scheduler.trigger("hourly");
    await until(() => releases.length === 2);
    releases[1]!();
    expect(await second).toMatchObject({ trigger: "manual", status: "succeeded" });
  });
});