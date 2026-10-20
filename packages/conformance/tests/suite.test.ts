import type {
  LeasedDelivery,
  MessageEnvelope
} from "@holqa/core";

import type { QueueHarness } from "@/queue";
import type { TestRunner } from "@/suite";

import {
  describe,
  expect,
  it
} from "bun:test";

import { queueConformance } from "@/queue";
import {
  ConformanceFailure,
  ConformanceSkip,
  deepEqual,
  eventually,
  expectEqual,
  registerConformance,
  runConformance
} from "@/suite";

/**
 * Builds a deliberately broken in-memory queue: acknowledgement does nothing,
 * so acknowledged messages are delivered again once their lease ends, and
 * nothing is ever delayed.
 *
 * @returns A harness for the broken queue, with immediate time.
 */
function brokenQueue(): QueueHarness {
  let now = 0;
  return {
    time: { advance: async (ms) => {
      now += ms;
    } },
    patienceMs: 300,
    leaseMs: 100,
    open: async () => {
      const messages: Array<{ id: string; envelope: MessageEnvelope; attempts: number; leasedUntil: number }> = [];
      return {
        capabilities: { delivery: ["at-least-once"], maxAttempts: 5, deadLetter: false },
        driver: { send: async (envelope) => {
          const id = `m-${messages.length + 1}`;
          messages.push({ id, envelope, attempts: 0, leasedUntil: -1 });
          return { messageId: id };
        } },
        source: {
          defaultMaxAttempts: 5,
          receive: async ({ max, leaseMs }) => {
            const due = messages.filter(message => message.leasedUntil <= now).slice(0, max);
            return due.map((message): LeasedDelivery<MessageEnvelope> => {
              message.attempts += 1;
              message.leasedUntil = now + leaseMs;
              return { receipt: `${message.id}:${message.attempts}`, id: message.id, attempt: message.attempts, body: message.envelope };
            });
          },
          acknowledge: async () => true,
          retry: async () => true,
          deadLetter: async () => true,
          discard: async () => true,
          wait: async () => {}
        },
        close: async () => {}
      };
    }
  };
}

describe("runConformance", () => {
  it("reports passed, failed and skipped cases, and detects a broken provider", async () => {
    const results = await runConformance(queueConformance, brokenQueue());
    const byName = new Map(results.map(result => [result.name, result.status]));
    expect(byName.get("a sent envelope is delivered unchanged, with its message identifier and attempt 1")).toBe("passed");
    expect(byName.get("an acknowledged message is not delivered again")).toBe("failed");
    expect(byName.get("a dead-lettered message is not delivered again")).toBe("skipped");
    expect(byName.get("a delayed message is not delivered before its delay")).toBe("skipped");
    expect(results.every(result => result.contract === "queue" && result.durationMs >= 0)).toBe(true);
    expect(results.find(result => result.status === "failed")?.message).toBe("An acknowledged message was delivered again.");
  });
});

describe("registerConformance", () => {
  it("registers one test per case, treating skips as passes", async () => {
    const registered: Array<{ readonly name: string; readonly body: () => Promise<void> }> = [];
    const runner: TestRunner = {
      describe: (name, body) => {
        expect(name).toBe("queue conformance");
        body();
      },
      it: (name, body) => registered.push({ name, body })
    };
    registerConformance(queueConformance, brokenQueue, runner);
    expect(registered.map(test => test.name)).toEqual(queueConformance.cases.map(entry => entry.name));
    const deadLetter = registered.find(test => test.name === "a dead-lettered message is not delivered again")!;
    await deadLetter.body();
    const acknowledged = registered.find(test => test.name === "an acknowledged message is not delivered again")!;
    await expect(acknowledged.body()).rejects.toBeInstanceOf(ConformanceFailure);
  });
});

describe("assertions", () => {
  it("compares structurally, including bytes, and ignores absent optional fields", () => {
    expect(deepEqual({ a: [1, { b: "x" }], c: undefined }, { a: [1, { b: "x" }] })).toBe(true);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(() => expectEqual("queue", 1, 2, "The value")).toThrow("The value: expected 2, received 1.");
    expect(new ConformanceSkip("n/a").name).toBe("ConformanceSkip");
  });

  it("waits by letting harness time pass until a probe succeeds or patience runs out", async () => {
    let now = 0;
    const time = { advance: async (ms: number) => {
      now += ms;
    } };
    expect(await eventually(time, 1_000, async () => now >= 300 ? now : undefined)).toBe(300);
    expect(await eventually(time, 200, async () => undefined)).toBeUndefined();
  });
});