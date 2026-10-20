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
  it("stores the publisher's telemetry context and counts pending messages", async () => {
    const { env, source } = await setup();
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    await env.binding.drivers.queue!(jobs).send({ format: messageEnvelopeFormat, schemaVersion: 1, payload: { name: "a" } }, {}, { trace: { correlationId: "c-1", rootId: "r-1", depth: 1, traceparent } });
    await send(env, "b", 60);
    expect(await source.pending?.()).toBe(2);
    const [delivery] = await source.receive({ max: 1, leaseMs: 1_000 });
    expect(delivery?.trace).toEqual({ correlationId: "c-1", rootId: "r-1", depth: 1, traceparent });
    await source.acknowledge(delivery!.receipt);
    expect(await source.pending?.()).toBe(1);
  });

  it("keeps the sender's trace with the message, its redeliveries and its duplicates", async () => {
    const { env, source } = await setup();
    const trace = { correlationId: "req-1", causationId: "inv-1" };
    const { messageId } = await env.binding.drivers.queue!(jobs).send({ format: messageEnvelopeFormat, schemaVersion: 1, payload: { name: "traced" } }, {}, { trace });
    const [first] = await source.receive({ max: 1, leaseMs: 1_000 });
    expect(first).toMatchObject({ id: messageId, trace });
    expect(await source.acknowledge(first!.receipt)).toBe(true);
    expect(env.queues.duplicate("jobs", messageId)).toBe(true);
    const [copy] = await source.receive({ max: 1, leaseMs: 1_000 });
    expect(copy).toMatchObject({ id: messageId, trace });
    expect(env.queues.messages("jobs").map(message => message.trace)).toEqual([trace, trace]);
    await send(env, "untraced");
    const [untraced] = await source.receive({ max: 1, leaseMs: 1_000 });
    expect(untraced!.trace).toBeUndefined();
  });

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

  it("keeps the lineage with the message and reports when it was sent", async () => {
    const { env, clock, source } = await setup();
    const trace = { correlationId: "req-1", causationId: "inv-1", rootId: "inv-0", depth: 2 };
    await env.binding.drivers.queue!(jobs).send({ format: messageEnvelopeFormat, schemaVersion: 1, payload: { name: "deep" } }, {}, { trace });
    clock.advance(5_000);
    const [delivery] = await source.receive({ max: 1, leaseMs: 1_000 });
    expect(delivery).toMatchObject({ trace, sentAt: "2026-10-18T10:00:00.000Z" });
    expect(env.queues.messages("jobs")[0]!.trace).toEqual(trace);
  });

  it("redrives dead letters oldest first, by limit, and optionally as new operations", async () => {
    const { env, source } = await setup();
    const trace = { correlationId: "req-1", causationId: "inv-1", rootId: "inv-0", depth: 16 };
    for (const name of ["a", "b", "c"])
      await env.binding.drivers.queue!(jobs).send({ format: messageEnvelopeFormat, schemaVersion: 1, payload: { name } }, {}, { trace });
    for (const delivery of await source.receive({ max: 3, leaseMs: 1_000 }))
      await source.deadLetter(delivery.receipt, { code: "HOLQA_EVENT_DEPTH_EXCEEDED", message: "too deep", attempt: 1 });
    const [first, second, third] = env.queues.deadLetters("jobs").map(message => message.messageId) as [string, string, string];
    expect(env.queues.redrive("jobs", { limit: 1 })).toBe(1);
    expect(env.queues.messages("jobs", ["ready"]).map(message => [message.messageId, message.trace])).toEqual([[first, trace]]);
    expect(env.queues.redrive("jobs", { messageId: third, newOperation: true })).toBe(1);
    const fresh = env.queues.messages("jobs", ["ready"]).find(message => message.messageId === third)!;
    expect(fresh.trace).toMatchObject({ correlationId: "req-1", depth: 0 });
    expect(fresh.trace?.rootId).toStartWith("redrive-");
    expect(fresh.trace).not.toHaveProperty("causationId");
    expect(fresh.sentAt).toBe("2026-10-18T10:00:00.000Z");
    expect(env.queues.deadLetters("jobs").map(message => message.messageId)).toEqual([second]);
    expect(env.queues.redrive("jobs")).toBe(1);
    for (const limit of [0, -1, 1.5, Number.NaN])
      expect(() => env.queues.redrive("jobs", { limit })).toThrow("whole number of at least 1");
  });

  it("gives a message redriven as a new operation a new send time, for age limits", async () => {
    const { env, clock, source } = await setup();
    await send(env, "old");
    const [delivery] = await source.receive({ max: 1, leaseMs: 1_000 });
    await source.deadLetter(delivery!.receipt, { code: "HOLQA_EVENT_AGE_EXCEEDED", message: "too old", attempt: 1 });
    clock.advance(60_000);
    env.queues.redrive("jobs", { newOperation: true });
    const [again] = await source.receive({ max: 1, leaseMs: 1_000 });
    expect(again!.sentAt).toBe("2026-10-18T10:01:00.000Z");
  });
});