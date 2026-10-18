import type { ResourceDescriptorOf } from "@holqa/core";

import type { LocalEnvironment } from "@/environment";
import { messageEnvelopeFormat } from "@holqa/core";
import {
  application,
  queueResource,
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

/** Cleanups to run after each test. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup();
});

/** The queue every test uses. */
const jobs = queueResource("jobs") as ResourceDescriptorOf<"queue">;

/**
 * Creates an environment with the `jobs` queue and starts receiving from it.
 *
 * @returns The environment, its clock and the queue's source.
 */
async function setup(): Promise<{ readonly env: LocalEnvironment; readonly clock: ManualClock; readonly source: ReturnType<NonNullable<NonNullable<LocalEnvironment["binding"]["sources"]>["queue"]>> }> {
  const directory = stateDirectory();
  cleanups.push(directory.remove);
  const clock = new ManualClock(Date.parse("2026-10-18T10:00:00.000Z"));
  const env = await createLocalEnvironment({ app: application([jobs]), directory: directory.path, clock, createId: sequentialIds("m-"), env: {}, queues: { defaultMaxAttempts: 7 } });
  cleanups.push(() => env.close());
  return { env, clock, source: env.binding.sources!.queue!(jobs) };
}

/**
 * Sends a `{ name }` message.
 *
 * @param env - The environment.
 * @param name - The message's name.
 * @param delaySeconds - A delivery delay.
 * @returns The message identifier.
 */
async function send(env: LocalEnvironment, name: string, delaySeconds = 0): Promise<string> {
  return (await env.binding.drivers.queue!(jobs).send({ format: messageEnvelopeFormat, schemaVersion: 1, payload: { name } }, delaySeconds === 0 ? {} : { delaySeconds })).messageId;
}

describe("local queues", () => {
  it("stores the envelope, reports each message's state and filters by state", async () => {
    const { env, clock, source } = await setup();
    expect(source.defaultMaxAttempts).toBe(7);
    const now = await send(env, "now");
    const later = await send(env, "later", 30);
    expect((await source.receive({ max: 5, leaseMs: 10_000 })).map(delivery => delivery.body)).toEqual([{ format: messageEnvelopeFormat, schemaVersion: 1, payload: { name: "now" } }]);
    expect(env.queues.messages("jobs").map(message => `${message.messageId}:${message.state}`)).toEqual([`${now}:in-flight`, `${later}:delayed`]);
    expect(env.queues.messages("jobs", ["delayed"]).map(message => message.messageId)).toEqual([later]);
    expect(env.queues.messages("jobs", ["ready"])).toEqual([]);
    clock.advance(30_000);
    expect(env.queues.messages("jobs", ["ready"]).map(message => ({ id: message.messageId, sentAt: message.sentAt, visibleAt: message.visibleAt }))).toEqual([
      { id: later, sentAt: "2026-10-18T10:00:00.000Z", visibleAt: "2026-10-18T10:00:30.000Z" }
    ]);
  });

  it("purges every message that is not in flight", async () => {
    const { env, source } = await setup();
    await send(env, "a");
    await source.receive({ max: 1, leaseMs: 10_000 });
    await send(env, "b");
    await send(env, "c", 10);
    expect(env.queues.purge("jobs")).toBe(2);
    expect(env.queues.messages("jobs").map(message => message.state)).toEqual(["in-flight"]);
  });

  it("returns nothing for unknown messages", async () => {
    const { env } = await setup();
    expect(env.queues.duplicate("jobs", "missing")).toBe(false);
    expect(env.queues.redrive("jobs", "missing")).toBe(0);
    expect(env.queues.deadLetters("jobs")).toEqual([]);
  });
});