import type {
  DeliveryTrace,
  LeasedDelivery,
  MessageEnvelope,
  QueueCapabilities,
  QueueDriver,
  QueueSource
} from "@holqa/core";

import type {
  ConformanceCase,
  ConformanceSuite,
  ConformanceTime
} from "@/suite";

import {
  ConformanceSkip,
  eventually,
  expectEqual,
  expectThat
} from "@/suite";

/** One fresh, empty queue of the provider under test. */
export interface QueueFixture {
  readonly driver: QueueDriver;
  readonly source: QueueSource;
  /** What the provider advertises for the queue. */
  readonly capabilities: QueueCapabilities;
  /** Releases the queue (and, for real infrastructure, deletes test data the harness created). */
  readonly close: () => Promise<void>;
}

/** What the queue cases need. */
export interface QueueHarness {
  /** Opens a fresh, empty queue for one case. */
  readonly open: () => Promise<QueueFixture>;
  readonly time: ConformanceTime;
  /** How long to wait for an expected delivery, in milliseconds of harness time. Default 5 000. */
  readonly patienceMs?: number;
  /** The lease used by cases that let a lease expire, in milliseconds. Default 1 000. */
  readonly leaseMs?: number;
}

/** The contract name of the queue cases. */
const contract = "queue";

/**
 * Builds a message envelope.
 *
 * @param payload - The wire payload to wrap.
 * @returns A version 1 envelope.
 */
function envelope(payload: MessageEnvelope["payload"]): MessageEnvelope {
  return { format: "holqa.message/1", schemaVersion: 1, payload };
}

/**
 * Runs a case against a fresh queue and always closes it.
 *
 * @param harness - What the cases need to reach the provider.
 * @param body - The case.
 */
async function withQueue(harness: QueueHarness, body: (queue: QueueFixture) => Promise<void>): Promise<void> {
  const queue = await harness.open();
  try {
    await body(queue);
  } finally {
    await queue.close();
  }
}

/**
 * Receives one delivery, waiting up to the harness's patience.
 *
 * @param harness - What the cases need to reach the provider.
 * @param queue - The queue under test.
 * @param leaseMs - The lease to request.
 * @returns The delivery, or `undefined` when none arrived.
 */
async function receiveOne(harness: QueueHarness, queue: QueueFixture, leaseMs = 30_000): Promise<LeasedDelivery<MessageEnvelope> | undefined> {
  return eventually(harness.time, harness.patienceMs ?? 5_000, async () => (await queue.source.receive({ max: 1, leaseMs }))[0]);
}

/**
 * Receives one delivery that must arrive.
 *
 * @param harness - What the cases need to reach the provider.
 * @param queue - The queue under test.
 * @param what - What is expected, for the failure message.
 * @param leaseMs - The lease to request.
 * @returns The leased delivery that arrived.
 */
async function expectDelivery(harness: QueueHarness, queue: QueueFixture, what: string, leaseMs?: number): Promise<LeasedDelivery<MessageEnvelope>> {
  const delivery = await receiveOne(harness, queue, leaseMs);
  expectThat(contract, delivery !== undefined, `${what} was not delivered within ${harness.patienceMs ?? 5_000} ms.`);
  return delivery;
}

/**
 * Checks that nothing is delivered right now, without letting time pass.
 *
 * @param queue - The queue under test.
 * @param what - Why nothing may be delivered.
 */
async function expectNothing(queue: QueueFixture, what: string): Promise<void> {
  const deliveries = await queue.source.receive({ max: 10, leaseMs: 30_000 });
  expectThat(contract, deliveries.length === 0, `${what}, but ${deliveries.length} deliver${deliveries.length === 1 ? "y was" : "ies were"} received.`);
}

/** A failure recorded with retried and dead-lettered deliveries. */
const failure = { code: "HOLQA_HANDLER_FAILED", message: "conformance failure", attempt: 1 } as const;

/**
 * The normative behaviour of the `queue` contract (version 1): a driver that
 * stores envelopes and assigns identifiers, and a source that leases,
 * settles and redelivers them at least once.
 */
export const queueConformance: ConformanceSuite<QueueHarness> = Object.freeze({
  contract,
  cases: Object.freeze<ConformanceCase<QueueHarness>[]>([
    {
      name: "a sent envelope is delivered unchanged, with its message identifier and attempt 1",
      run: harness => withQueue(harness, async (queue) => {
        const payload = { orderId: "o-1", lines: [{ sku: "a", quantity: 2 }], note: "café ☕ 注文", nothing: null };
        const { messageId } = await queue.driver.send(envelope(payload), {});
        expectThat(contract, typeof messageId === "string" && messageId !== "", "send must resolve with a non-empty message identifier.");
        const delivery = await expectDelivery(harness, queue, "The sent message");
        expectEqual(contract, delivery.id, messageId, "The delivery's identifier");
        expectEqual(contract, delivery.attempt, 1, "The first delivery's attempt");
        expectEqual(contract, delivery.body, envelope(payload), "The delivered envelope");
        expectThat(contract, typeof delivery.receipt === "string" && delivery.receipt !== "", "A delivery must carry a receipt.");
        await queue.source.acknowledge(delivery.receipt);
      })
    },
    {
      name: "every send gets its own message identifier",
      run: harness => withQueue(harness, async (queue) => {
        const first = await queue.driver.send(envelope("a"), {});
        const second = await queue.driver.send(envelope("a"), {});
        expectThat(contract, first.messageId !== second.messageId, "Two sends of the same payload must get different message identifiers.");
      })
    },
    {
      name: "a leased delivery is not received again while its lease lasts",
      run: harness => withQueue(harness, async (queue) => {
        await queue.driver.send(envelope("leased"), {});
        await expectDelivery(harness, queue, "The sent message");
        await expectNothing(queue, "The only message is leased");
      })
    },
    {
      name: "receive returns at most the requested number of deliveries",
      run: harness => withQueue(harness, async (queue) => {
        for (const index of [1, 2, 3])
          await queue.driver.send(envelope(index), {});
        const all = await eventually(harness.time, harness.patienceMs ?? 5_000, async () => {
          const pending = queue.source.pending === undefined ? 3 : await queue.source.pending();
          return pending >= 3 ? true : undefined;
        });
        expectThat(contract, all === true, "Three sent messages did not become pending.");
        const deliveries = await eventually(harness.time, harness.patienceMs ?? 5_000, async () => {
          const received = await queue.source.receive({ max: 2, leaseMs: 30_000 });
          return received.length > 0 ? received : undefined;
        });
        expectThat(contract, deliveries !== undefined && deliveries.length >= 1 && deliveries.length <= 2, `receive({ max: 2 }) must return one or two deliveries, not ${deliveries?.length ?? 0}.`);
      })
    },
    {
      name: "an acknowledged message is not delivered again",
      run: harness => withQueue(harness, async (queue) => {
        await queue.driver.send(envelope("ack"), {});
        const delivery = await expectDelivery(harness, queue, "The sent message", harness.leaseMs ?? 1_000);
        expectEqual(contract, await queue.source.acknowledge(delivery.receipt), true, "acknowledge of a held lease");
        await harness.time.advance((harness.leaseMs ?? 1_000) * 2);
        expectThat(contract, await receiveOne({ ...harness, patienceMs: 500 }, queue) === undefined, "An acknowledged message was delivered again.");
      })
    },
    {
      name: "a retried message is delivered again no earlier than its delay, with a higher attempt and the same identifier",
      run: harness => withQueue(harness, async (queue) => {
        if ((queue.capabilities.maxDelaySeconds ?? 0) < 1)
          throw new ConformanceSkip("The provider advertises no redelivery delays.");
        const { messageId } = await queue.driver.send(envelope("retry"), {});
        const first = await expectDelivery(harness, queue, "The sent message");
        expectEqual(contract, await queue.source.retry(first.receipt, 1_000, failure), true, "retry of a held lease");
        await expectNothing(queue, "The message was retried with a delay of 1 000 ms");
        const second = await expectDelivery(harness, queue, "The retried message");
        expectEqual(contract, second.id, messageId, "The redelivery's identifier");
        expectThat(contract, second.attempt > first.attempt, `A redelivery must have a higher attempt than ${first.attempt}, not ${second.attempt}.`);
      })
    },
    {
      name: "a message whose lease expires is delivered again with a higher attempt and the same identifier",
      run: harness => withQueue(harness, async (queue) => {
        const leaseMs = harness.leaseMs ?? 1_000;
        const { messageId } = await queue.driver.send(envelope("expiring"), {});
        const first = await expectDelivery(harness, queue, "The sent message", leaseMs);
        await harness.time.advance(leaseMs);
        const second = await expectDelivery(harness, queue, "The message whose lease expired");
        expectEqual(contract, second.id, messageId, "The redelivery's identifier");
        expectThat(contract, second.attempt > first.attempt, `A redelivery after an expired lease must have a higher attempt than ${first.attempt}, not ${second.attempt}.`);
        expectEqual(contract, await queue.source.acknowledge(first.receipt), false, "acknowledge with the receipt of an expired lease");
        expectEqual(contract, await queue.source.acknowledge(second.receipt), true, "acknowledge with the current receipt");
      })
    },
    {
      name: "extending a lease keeps the delivery leased beyond its original length",
      run: harness => withQueue(harness, async (queue) => {
        const extend = queue.source.extend;
        if (extend === undefined)
          throw new ConformanceSkip("The provider's source cannot extend leases.");
        const leaseMs = harness.leaseMs ?? 1_000;
        await queue.driver.send(envelope("extended"), {});
        const delivery = await expectDelivery(harness, queue, "The sent message", leaseMs);
        await harness.time.advance(leaseMs / 2);
        expectEqual(contract, await extend(delivery.receipt, leaseMs * 4), true, "extend of a held lease");
        await harness.time.advance(leaseMs * 2);
        await expectNothing(queue, "The lease was extended");
        expectEqual(contract, await queue.source.acknowledge(delivery.receipt), true, "acknowledge after extending");
      })
    },
    {
      name: "a dead-lettered message is not delivered again",
      run: harness => withQueue(harness, async (queue) => {
        if (!queue.capabilities.deadLetter)
          throw new ConformanceSkip("The provider advertises no dead-letter destination.");
        await queue.driver.send(envelope("dead"), {});
        const delivery = await expectDelivery(harness, queue, "The sent message", harness.leaseMs ?? 1_000);
        expectEqual(contract, await queue.source.deadLetter(delivery.receipt, failure), true, "deadLetter of a held lease");
        await harness.time.advance((harness.leaseMs ?? 1_000) * 2);
        expectThat(contract, await receiveOne({ ...harness, patienceMs: 500 }, queue) === undefined, "A dead-lettered message was delivered again.");
      })
    },
    {
      name: "a discarded message is not delivered again",
      run: harness => withQueue(harness, async (queue) => {
        await queue.driver.send(envelope("discarded"), {});
        const delivery = await expectDelivery(harness, queue, "The sent message", harness.leaseMs ?? 1_000);
        expectEqual(contract, await queue.source.discard(delivery.receipt, failure), true, "discard of a held lease");
        await harness.time.advance((harness.leaseMs ?? 1_000) * 2);
        expectThat(contract, await receiveOne({ ...harness, patienceMs: 500 }, queue) === undefined, "A discarded message was delivered again.");
      })
    },
    {
      name: "a delayed message is not delivered before its delay",
      run: harness => withQueue(harness, async (queue) => {
        if ((queue.capabilities.maxDelaySeconds ?? 0) < 1)
          throw new ConformanceSkip("The provider advertises no delayed delivery.");
        const { messageId } = await queue.driver.send(envelope("later"), { delaySeconds: 1 });
        await expectNothing(queue, "The message was sent with a delay of 1 second");
        const delivery = await expectDelivery(harness, queue, "The delayed message");
        expectEqual(contract, delivery.id, messageId, "The delayed delivery's identifier");
      })
    },
    {
      name: "the sender's trace and lineage travel with the message",
      run: harness => withQueue(harness, async (queue) => {
        const trace: DeliveryTrace = { correlationId: "c-1", causationId: "inv-1", rootId: "inv-1", depth: 1, traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" };
        await queue.driver.send(envelope("traced"), {}, { trace });
        const delivery = await expectDelivery(harness, queue, "The traced message");
        expectEqual(contract, delivery.trace, trace, "The delivery's trace");
        expectThat(contract, delivery.sentAt === undefined || !Number.isNaN(Date.parse(delivery.sentAt)), "sentAt must be an ISO 8601 time when present.");
      })
    },
    {
      name: "wait resolves at once when its signal is aborted",
      run: harness => withQueue(harness, async (queue) => {
        const controller = new AbortController();
        controller.abort();
        const outcome = await Promise.race([queue.source.wait(controller.signal).then(() => "resolved"), new Promise(resolve => setTimeout(resolve, 2_000, "hung"))]);
        expectEqual(contract, outcome, "resolved", "wait with an aborted signal");
      })
    }
  ])
});