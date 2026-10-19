import type { DeliveryWorkerOptions } from "@/delivery/delivery-worker";
import type { InvocationOutcome } from "@/dispatch/dispatcher";

import { recordingSink } from "@test/support/descriptors";
import { MemorySource } from "@test/support/memory-sources";
import {
  describe,
  expect,
  it
} from "bun:test";

import { DeliveryWorker } from "@/delivery/delivery-worker";
import { StructuredLogger } from "@/logging/log";

/** A successful outcome. */
const succeeded: InvocationOutcome = { ok: true, value: undefined, invocationId: "inv", correlationId: "c", handlerId: "h", durationMs: 0, emitted: [] };

/**
 * Creates a worker over a source with a fixed policy.
 *
 * @param source - The deliveries.
 * @param overrides - Settings to replace.
 * @returns A worker that is not started yet.
 */
function workerOf(source: MemorySource<string>, overrides: Partial<DeliveryWorkerOptions<string>> = {}): DeliveryWorker<string> {
  return new DeliveryWorker<string>({
    handlerId: "h",
    source,
    policy: { maxAttempts: 2, backoff: { strategy: "fixed", delaySeconds: 1 }, deadLetter: true },
    concurrency: 1,
    leaseMs: 1_000,
    timeoutMs: 1_000,
    prepare: async delivery => ({ kind: "invoke", input: delivery.body, metadata: {} }),
    dispatch: async () => succeeded,
    stopping: () => false,
    logger: new StructuredLogger(() => {}),
    pause: async () => {},
    ...overrides
  });
}

describe("DeliveryWorker", () => {
  it("keeps receiving after the source fails, and logs the failure", async () => {
    const source = new MemorySource<string>();
    const { sink, entries } = recordingSink();
    let failures = 1;
    const receive = source.receive.bind(source);
    source.receive = async (request) => {
      if (failures-- > 0)
        throw new Error("database locked");
      return receive(request);
    };
    const worker = workerOf(source, { logger: new StructuredLogger(sink) });
    source.add("d-1", "x");
    worker.start();
    await source.drained();
    await worker.stopReceiving();
    await worker.settled();
    expect(worker.stats()).toMatchObject({ received: 1, acknowledged: 1 });
    expect(entries.map(entry => entry.message)).toContain("receiving deliveries failed; retrying");
  });

  it("counts settlements that lost their lease instead of failing", async () => {
    const source = new MemorySource<string>();
    source.acknowledge = async () => false;
    const worker = workerOf(source);
    source.add("d-1", "x");
    worker.start();
    for (let round = 0; round < 100 && worker.stats().leasesLost === 0; round += 1)
      await Bun.sleep(1);
    await worker.stopReceiving();
    await worker.settled();
    expect(worker.stats()).toMatchObject({ received: 1, acknowledged: 0, leasesLost: 1 });
  });

  it("treats a delivery that cannot be read as a non-retryable failure", async () => {
    const source = new MemorySource<string>();
    const worker = workerOf(source, { prepare: async () => {
      throw new Error("corrupt");
    } });
    source.add("d-1", "x");
    worker.start();
    await source.drained();
    await worker.stopReceiving();
    expect(source.settlements.map(settlement => `${settlement.kind}:${settlement.failure?.code}`)).toEqual(["deadLetter:HOLQA_PAYLOAD_MALFORMED"]);
  });
});