import type {
  DeliveryFailure,
  DeliverySource,
  DeliveryTrace,
  JsonObject,
  LeasedDelivery,
  MessageEnvelope,
  QueueDriver,
  QueueSource
} from "@holqa/core";

import type { QueueTopology } from "@/topology";
import type {
  AmqpMessage,
  AmqpSettlement,
  AmqpTransport
} from "@/transport";

import {
  bindingFailure,
  decodeMessageEnvelope,
  HolqaError
} from "@holqa/core";

import { delayStep } from "@/topology";

/** Header names under which Holqa's metadata travels with a message. */
export const headers = Object.freeze({
  /** Attempts made before this copy was published (by a retry or an expired lease). */
  attempts: "x-holqa-attempts",
  /** The sender's `DeliveryTrace`, as JSON. */
  trace: "x-holqa-trace",
  /** When the message was first sent (ISO 8601). Kept across retries. */
  sentAt: "x-holqa-sent-at",
  failureCode: "x-holqa-failure-code",
  failureMessage: "x-holqa-failure-message",
  failureAttempt: "x-holqa-failure-attempt",
  failureInvocation: "x-holqa-failure-invocation",
  /** The broker's redelivery count on quorum queues. */
  deliveryCount: "x-delivery-count"
});

/** Settings of {@link createQueueBinding}. */
export interface QueueBindingSettings {
  readonly binding: string;
  readonly transport: AmqpTransport;
  readonly topology: QueueTopology;
  readonly prefetch: number;
  readonly defaultMaxAttempts: number;
  readonly createId: () => string;
  readonly now: () => number;
  /** Calls a function after a delay and returns a function that cancels it. */
  readonly setTimer: (delayMs: number, callback: () => void) => () => void;
  /** How often an idle receiver checks for work, in milliseconds. */
  readonly pollIntervalMs: number;
  /** Writes a structured log entry attributed to the provider. */
  readonly log: (level: "debug" | "info" | "warn" | "error", message: string, fields?: JsonObject) => void;
}

/** A delivery the broker handed over, waiting to be leased or settled. */
interface Held<Body> {
  readonly receipt: string;
  readonly message: AmqpMessage;
  readonly generation: number;
  readonly delivery: LeasedDelivery<Body>;
  readonly settle: (settlement: AmqpSettlement) => void;
  leased: boolean;
  cancelTimer?: () => void;
  settled: boolean;
}

/**
 * Reads a whole-number header.
 *
 * @param value - The header value.
 * @returns The number, or 0.
 */
function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Reads the trace header, ignoring anything malformed: the runtime treats an
 * absent trace as the start of a new lineage.
 *
 * @param value - The header value.
 * @returns The trace, or `undefined`.
 */
function traceOf(value: unknown): DeliveryTrace | undefined {
  if (typeof value !== "string")
    return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && typeof (parsed as { readonly correlationId?: unknown }).correlationId === "string" ? parsed as DeliveryTrace : undefined;
  } catch {
    // A foreign producer's header is not Holqa's trace; delivery goes on without it.
    return undefined;
  }
}

/**
 * Creates the driver and source of one Holqa queue on a broker queue.
 *
 * Delivery is at least once. Messages are published with publisher
 * confirms; `send` resolves only once the broker confirmed the message. A
 * delivery stays leased while its timer runs; when it expires, a copy with a
 * higher attempt count is published and the original acknowledged, so the
 * attempt count is exact on every queue type. A retry publishes the copy to
 * the delay queue for the next delay step (never shorter than asked) and
 * acknowledges the original; dead-lettering publishes it to the dead-letter
 * queue with the failure, and acknowledges. Copies are published before the
 * original is acknowledged, so a crash in between duplicates rather than loses
 * a message. When the connection is lost, unsettled messages return to the
 * queue and settlements of them report a lost lease.
 *
 * @param settings - Transport, topology and limits.
 * @returns The driver and the source.
 */
export function createQueueBinding(settings: QueueBindingSettings): { readonly driver: QueueDriver; readonly source: QueueSource; readonly stop: () => Promise<void> } {
  return createLeasedBinding<MessageEnvelope>(settings, body => decodeMessageEnvelope(new TextDecoder().decode(body), `message for queue "${settings.topology.queue}"`));
}

/**
 * Creates the driver and source of one broker queue with any body format:
 * {@link createQueueBinding} decodes Holqa envelopes, an event channel passes
 * raw notifications. A body `decode` rejects is quarantined.
 *
 * @param settings - Transport, topology and limits.
 * @param decode - Turns message bytes into a delivery body; throws for bytes it cannot read.
 * @returns The driver (for envelopes), the source and the stop function.
 */
export function createLeasedBinding<Body>(settings: QueueBindingSettings, decode: (body: Uint8Array) => Body): { readonly driver: QueueDriver; readonly source: DeliverySource<Body> & Pick<QueueSource, "defaultMaxAttempts" | "pending">; readonly stop: () => Promise<void> } {
  const { binding, transport, topology } = settings;
  const encoder = new TextEncoder();
  const held = new Map<string, Held<Body>>();
  const waiters = new Set<() => void>();
  let consumer: Promise<{ readonly close: () => Promise<void> }> | undefined;
  let stopped = false;

  /** Wakes every waiting receiver. */
  const wake = (): void => {
    for (const waiter of [...waiters])
      waiter();
  };
  /**
   * Publishes a message body to a queue.
   *
   * @param queue - The broker queue.
   * @param body - The envelope bytes.
   * @param messageId - The Holqa message identifier.
   * @param metadata - Holqa headers.
   */
  const publish = async (queue: string, body: Uint8Array, messageId: string, metadata: Readonly<Record<string, string | number>>): Promise<void> => {
    if (stopped)
      throw new HolqaError(bindingFailure("unavailable", { binding, message: "The queue binding has stopped." }));
    await transport.publish(queue, body, { messageId, headers: metadata });
  };
  /**
   * Settles a held message with the broker and forgets it.
   *
   * @param entry - The held message.
   * @param settlement - Acknowledge or requeue.
   */
  const finish = (entry: Held<Body>, settlement: AmqpSettlement): void => {
    if (entry.settled)
      return;
    entry.settled = true;
    entry.cancelTimer?.();
    held.delete(entry.receipt);
    entry.settle(settlement);
  };
  /**
   * Publishes a copy of a held message with more attempts recorded, then
   * acknowledges the original. A failed publish requeues the original instead.
   *
   * @param entry - The held message.
   * @param queue - Where the copy goes.
   * @param extra - Headers to add, for example the failure.
   * @returns Whether the copy was published.
   */
  const forward = async (entry: Held<Body>, queue: string, extra: Readonly<Record<string, string | number>> = {}): Promise<boolean> => {
    const metadata: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(entry.message.headers)) {
      if (typeof value === "string" || typeof value === "number")
        metadata[name] = value;
    }
    delete metadata[headers.deliveryCount];
    metadata[headers.attempts] = entry.delivery.attempt;
    try {
      await publish(queue, entry.message.body, entry.delivery.id, { ...metadata, ...extra });
    } catch {
      // The copy did not reach the broker: requeue the original, so nothing is lost.
      finish(entry, "requeue");
      return false;
    }
    finish(entry, "ack");
    return true;
  };
  /**
   * Returns a held message whose lease is current, or `undefined` when it was lost.
   *
   * @param receipt - The receipt the delivery was leased with.
   * @returns The entry, when it can still be settled.
   */
  const current = (receipt: string): Held<Body> | undefined => {
    const entry = held.get(receipt);
    if (entry === undefined || entry.settled || !entry.leased || entry.generation !== transport.generation())
      return undefined;
    return entry;
  };
  /**
   * Starts the lease timer of a delivery.
   *
   * @param entry - The delivery.
   * @param leaseMs - The lease length.
   */
  const lease = (entry: Held<Body>, leaseMs: number): void => {
    entry.cancelTimer?.();
    entry.cancelTimer = settings.setTimer(leaseMs, () => {
      // An expired lease makes the message due again, one attempt further.
      void forward(entry, topology.queue);
    });
  };
  /**
   * Moves a message that is not a Holqa envelope out of the queue: to the
   * dead-letter queue with `HOLQA_PAYLOAD_MALFORMED` when there is one,
   * otherwise it is discarded and a warning is logged. It is never redelivered
   * to the consumer, which could not decode it either.
   *
   * @param message - The malformed message.
   * @param settle - Settles it with the broker.
   */
  const quarantine = async (message: AmqpMessage, settle: (settlement: AmqpSettlement) => void): Promise<void> => {
    const messageId = message.messageId ?? settings.createId();
    if (topology.deadLetter !== undefined) {
      try {
        await publish(topology.deadLetter, message.body, messageId, { [headers.failureCode]: "HOLQA_PAYLOAD_MALFORMED", [headers.failureMessage]: "The message is not a holqa.message/1 envelope.", [headers.failureAttempt]: 1 });
      } catch {
        // The dead-letter queue is unreachable: requeue rather than lose the message.
        settle("requeue");
        return;
      }
    } else {
      settings.log("warn", "a message that is not a Holqa envelope was discarded; the queue has no dead-letter queue", { queue: topology.queue, messageId });
    }
    settle("ack");
  };
  /**
   * Starts consuming once, the first time a receiver asks for work.
   *
   * @returns The consumer, started on the first call and shared afterwards.
   */
  const startConsumer = (): Promise<{ readonly close: () => Promise<void> }> => {
    consumer ??= transport.consume(topology.queue, settings.prefetch, (message, generation) => new Promise<AmqpSettlement>((resolve) => {
      const receipt = settings.createId();
      let body: Body;
      try {
        body = decode(message.body);
      } catch {
        void quarantine(message, resolve);
        return;
      }
      const previous = count(message.headers[headers.attempts]);
      const redeliveries = message.headers[headers.deliveryCount] === undefined ? (message.redelivered ? 1 : 0) : count(message.headers[headers.deliveryCount]);
      const trace = traceOf(message.headers[headers.trace]);
      const sentAt = typeof message.headers[headers.sentAt] === "string" ? message.headers[headers.sentAt] as string : undefined;
      const entry: Held<Body> = {
        receipt,
        message,
        generation,
        delivery: Object.freeze({
          receipt,
          id: message.messageId ?? receipt,
          attempt: previous + redeliveries + 1,
          body,
          ...trace === undefined ? {} : { trace },
          ...sentAt === undefined ? {} : { sentAt }
        }),
        settle: resolve,
        leased: false,
        settled: false
      };
      held.set(receipt, entry);
      wake();
    }));
    return consumer;
  };

  const driver = Object.freeze<QueueDriver>({
    send: async (envelope, options, context) => {
      const delay = options.delaySeconds ?? 0;
      const queue = delay > 0 ? topology.delays[delayStep(delay)] : topology.queue;
      if (queue === undefined)
        throw new HolqaError(bindingFailure("capability", { binding, message: `Queue "${topology.queue}" has no delay queues; delayed sends need delayedDelivery: "delay-queues".` }));
      const messageId = settings.createId();
      await publish(queue, encoder.encode(JSON.stringify(envelope)), messageId, {
        [headers.attempts]: 0,
        [headers.sentAt]: new Date(settings.now()).toISOString(),
        ...context?.trace === undefined ? {} : { [headers.trace]: JSON.stringify(context.trace) }
      });
      return Object.freeze({ messageId });
    }
  });

  const source = Object.freeze<DeliverySource<Body> & Pick<QueueSource, "defaultMaxAttempts" | "pending">>({
    defaultMaxAttempts: settings.defaultMaxAttempts,
    receive: async ({ max, leaseMs }) => {
      await startConsumer();
      const deliveries: Array<LeasedDelivery<Body>> = [];
      for (const entry of held.values()) {
        if (deliveries.length >= max)
          break;
        if (entry.leased || entry.settled)
          continue;
        if (entry.generation !== transport.generation()) {
          // The broker already returned it to the queue when the connection dropped.
          held.delete(entry.receipt);
          continue;
        }
        entry.leased = true;
        lease(entry, leaseMs);
        deliveries.push(entry.delivery);
      }
      return deliveries;
    },
    acknowledge: async (receipt) => {
      const entry = current(receipt);
      if (entry === undefined)
        return false;
      finish(entry, "ack");
      return true;
    },
    retry: async (receipt, delayMs, failure: DeliveryFailure) => {
      const entry = current(receipt);
      if (entry === undefined)
        return false;
      const seconds = Math.ceil(delayMs / 1000);
      const queue = seconds <= 0 ? topology.queue : topology.delays[delayStep(seconds)];
      if (queue === undefined)
        throw new HolqaError(bindingFailure("capability", { binding, message: `Queue "${topology.queue}" cannot delay redeliveries without delay queues.` }));
      entry.cancelTimer?.();
      return forward(entry, queue, failureHeaders(failure));
    },
    deadLetter: async (receipt, failure: DeliveryFailure) => {
      const entry = current(receipt);
      if (entry === undefined)
        return false;
      if (topology.deadLetter === undefined)
        throw new HolqaError(bindingFailure("capability", { binding, message: `Queue "${topology.queue}" has no dead-letter queue.` }));
      entry.cancelTimer?.();
      return forward(entry, topology.deadLetter, failureHeaders(failure));
    },
    discard: async (receipt) => {
      const entry = current(receipt);
      if (entry === undefined)
        return false;
      finish(entry, "ack");
      return true;
    },
    extend: async (receipt, leaseMs) => {
      const entry = current(receipt);
      if (entry === undefined)
        return false;
      lease(entry, leaseMs);
      return true;
    },
    wait: signal => new Promise<void>((resolve) => {
      const hasWork = [...held.values()].some(entry => !entry.leased && !entry.settled);
      if (signal.aborted || hasWork || stopped) {
        resolve();
        return;
      }
      void startConsumer();
      /** Cancels the polling timer; replaced once the timer is armed. */
      let cancel = (): void => {};
      /** Resolves the wait once. */
      const done = (): void => {
        cancel();
        waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      cancel = settings.setTimer(settings.pollIntervalMs, done);
      waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    }),
    pending: async () => (await transport.inspect(topology.queue))?.messageCount ?? 0
  });

  return {
    driver,
    source,
    stop: async () => {
      stopped = true;
      wake();
      // Unsettled deliveries go back to the queue for the next consumer.
      for (const entry of [...held.values()])
        finish(entry, "requeue");
      await (await consumer)?.close();
    }
  };
}

/**
 * Builds the headers that record a failure.
 *
 * @param failure - The failure of the attempt that ends the delivery.
 * @returns The `x-holqa-failure-*` headers.
 */
function failureHeaders(failure: DeliveryFailure): Record<string, string | number> {
  return {
    [headers.failureCode]: failure.code,
    [headers.failureMessage]: failure.message.slice(0, 1_000),
    [headers.failureAttempt]: failure.attempt,
    ...failure.invocationId === undefined ? {} : { [headers.failureInvocation]: failure.invocationId }
  };
}