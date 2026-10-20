import type { ResourceDescriptorOf } from "@holqa/core";

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
import { readDeliveryHistory } from "@/state/delivery-history";

/** Cleanups to run after each test. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup();
});

/** The queue the test uses. */
const jobs = queueResource("jobs") as ResourceDescriptorOf<"queue">;

describe("readDeliveryHistory", () => {
  it("reports a message's state, attempts, last error and lineage without changing the state", async () => {
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    const env = await createLocalEnvironment({ app: application([jobs]), directory: directory.path, clock: new ManualClock(Date.parse("2026-10-20T10:00:00.000Z")), createId: sequentialIds("m-"), env: {} });
    cleanups.push(() => env.close());
    const { messageId } = await env.binding.drivers.queue!(jobs).send({ format: messageEnvelopeFormat, schemaVersion: 1, payload: {} }, {}, { trace: { correlationId: "c-1", causationId: "inv-1", rootId: "inv-1", depth: 1, traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" } });
    const source = env.binding.sources!.queue!(jobs);
    const [delivery] = await source.receive({ max: 1, leaseMs: 1_000 });
    await source.deadLetter(delivery!.receipt, { code: "HOLQA_HANDLER_FAILED", message: "boom", attempt: 1, invocationId: "inv-2" });

    expect(readDeliveryHistory(directory.path, messageId)).toEqual({
      id: messageId,
      deliveries: [{
        kind: "queue.message",
        resourceId: "jobs",
        state: "dead",
        attempts: 1,
        sentAt: "2026-10-20T10:00:00.000Z",
        visibleAt: expect.any(String),
        updatedAt: "2026-10-20T10:00:00.000Z",
        lastError: { code: "HOLQA_HANDLER_FAILED", message: "boom", invocationId: "inv-2" },
        trace: { correlationId: "c-1", causationId: "inv-1", rootId: "inv-1", depth: 1, traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }
      }]
    });
    expect(readDeliveryHistory(directory.path, "unknown")).toBeUndefined();
  });

  it("reports nothing for a directory without state", () => {
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    expect(readDeliveryHistory(directory.path, "m-1")).toBeUndefined();
  });
});