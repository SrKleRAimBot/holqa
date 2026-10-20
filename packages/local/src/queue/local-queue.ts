import type {
  DeliveryTrace,
  JsonValue,
  MessageEnvelope,
  QueueDriver,
  QueueSource,
  ResourceDescriptorOf
} from "@holqa/core";

import type { Clock } from "@/clock";
import type {
  DeliveryState,
  LeaseStore,
  StoredDelivery
} from "@/state/lease-store";

import {
  decodeMessageEnvelope,
  diagnosticCodes,
  failWith
} from "@holqa/core";

/** Where a local queue message is, as inspection reports it. */
export type LocalMessageState = "ready" | "delayed" | "in-flight" | "acknowledged" | "dead-lettered";

/** One message of a local queue, for inspection. */
export interface LocalQueueMessage {
  readonly messageId: string;
  readonly state: LocalMessageState;
  /** Deliveries so far, including leases that expired. */
  readonly attempts: number;
  readonly schemaVersion: number;
  /** The wire payload, as sent. */
  readonly payload: JsonValue;
  /** When the message was sent (ISO 8601). */
  readonly sentAt: string;
  /** When it becomes due or its lease ends (ISO 8601); for settled messages, the last change. */
  readonly visibleAt: string;
  /** The failure of the last attempt, for retried and dead-lettered messages. */
  readonly lastError?: { readonly code: string; readonly message: string; readonly invocationId?: string };
  /** The trace of the invocation that sent the message: its `correlationId` and, as `causationId`, its `invocationId`. */
  readonly trace?: DeliveryTrace;
}

/**
 * Inspection and failure simulation for the local queues. Everything here
 * acts on the local state directly and is meant for development and tests.
 */
export interface LocalQueues {
  /** Lists a queue's messages, oldest first, optionally only in some states. */
  readonly messages: (queueId: string, states?: readonly LocalMessageState[]) => LocalQueueMessage[];
  /** Lists a queue's dead-lettered messages. */
  readonly deadLetters: (queueId: string) => LocalQueueMessage[];
  /**
   * Makes dead-lettered messages due again with a fresh attempt count, oldest
   * first: all of them, the one with a message identifier (a string), or
   * those {@link RedriveOptions} select. Returns how many.
   *
   * @throws {HolqaError} `HOLQA_OPERATION_INVALID` for a `limit` that is not a positive whole number.
   */
  readonly redrive: (queueId: string, selection?: string | RedriveOptions) => number;
  /** Delivers a known message once more, with the same message identifier, to test that consumers are idempotent. */
  readonly duplicate: (queueId: string, messageId: string) => boolean;
  /** Deletes every message that is not in flight. Returns how many. */
  readonly purge: (queueId: string) => number;
}

/** Which dead-lettered messages {@link LocalQueues.redrive} makes due again, and how. */
export interface RedriveOptions {
  /** Only the message with this identifier. */
  readonly messageId?: string;
  /** At most this many messages, oldest first. */
  readonly limit?: number;
  /**
   * Start a new root operation for every redriven message: depth 0, a fresh
   * operation budget and a new send time (so `maxEventAgeMs` counts from the
   * redrive), keeping its correlation. Without it, a message
   * keeps its lineage, so one refused for its depth or budget is refused again.
   */
  readonly newOperation?: boolean;
}

/** Settings of {@link createLocalQueues}. */
export interface LocalQueueSettings {
  readonly store: LeaseStore;
  readonly clock: Clock;
  readonly createId: () => string;
  /** Attempts for queues that declare no `maxAttempts`. */
  readonly defaultMaxAttempts: number;
}

/**
 * The channel of a queue's messages.
 *
 * @param queueId - The queue's identifier.
 * @returns The channel name.
 */
export function queueChannel(queueId: string): string {
  return `queue:${queueId}`;
}

/**
 * Creates the queue part of a local environment: drivers that persist sent
 * envelopes, sources that lease them to the runtime, and inspection.
 *
 * @param settings - The lease store, clock and identifiers.
 * @returns The driver and source factories, and the inspection API.
 */
export function createLocalQueues(settings: LocalQueueSettings): {
  readonly driver: (resource: ResourceDescriptorOf<"queue">) => QueueDriver;
  readonly source: (resource: ResourceDescriptorOf<"queue">) => QueueSource;
  readonly queues: LocalQueues;
} {
  const { store, clock, createId, defaultMaxAttempts } = settings;
  /**
   * Converts a stored delivery into its inspection form.
   *
   * @param delivery - The stored delivery.
   * @returns The message as inspection reports it.
   */
  const toMessage = (delivery: StoredDelivery): LocalQueueMessage => {
    const envelope = decodeMessageEnvelope(delivery.body, "stored queue message");
    const now = clock.now();
    const state: LocalMessageState = delivery.state === "dead"
      ? "dead-lettered"
      : delivery.state === "acknowledged"
        ? "acknowledged"
        : delivery.state === "leased" && delivery.visibleAt > now
          ? "in-flight"
          : delivery.visibleAt > now ? "delayed" : "ready";
    return Object.freeze({
      messageId: delivery.id,
      state,
      attempts: delivery.attempts,
      schemaVersion: envelope.schemaVersion,
      payload: envelope.payload,
      sentAt: new Date(delivery.createdAt).toISOString(),
      visibleAt: new Date(delivery.visibleAt).toISOString(),
      ...delivery.lastError === undefined ? {} : { lastError: delivery.lastError },
      ...delivery.trace === undefined ? {} : { trace: delivery.trace }
    });
  };
  /** Which stored states can hold messages in each inspection state. */
  const storedStates: Readonly<Record<LocalMessageState, DeliveryState>> = { "ready": "ready", "delayed": "ready", "in-flight": "leased", "acknowledged": "acknowledged", "dead-lettered": "dead" };
  return {
    driver: resource => Object.freeze<QueueDriver>({
      send: async (envelope: MessageEnvelope, options, context) => {
        const messageId = createId();
        const channel = queueChannel(resource.id);
        store.prune();
        store.add(channel, messageId, JSON.stringify({ format: envelope.format, schemaVersion: envelope.schemaVersion, ...envelope.fingerprint === undefined ? {} : { fingerprint: envelope.fingerprint }, payload: envelope.payload }), (options.delaySeconds ?? 0) * 1000, context?.trace);
        store.notify(channel);
        return Object.freeze({ messageId });
      }
    }),
    source: resource => Object.freeze({
      ...store.source<MessageEnvelope>(queueChannel(resource.id), body => decodeMessageEnvelope(body, `message for queue "${resource.id}"`)),
      defaultMaxAttempts,
      pending: async () => store.pending(queueChannel(resource.id))
    }),
    queues: Object.freeze({
      messages: (queueId: string, states?: readonly LocalMessageState[]) => {
        const messages = store.list(queueChannel(queueId), states?.map(state => storedStates[state])).map(toMessage);
        return states === undefined ? messages : messages.filter(message => states.includes(message.state));
      },
      deadLetters: (queueId: string) => store.list(queueChannel(queueId), ["dead"]).map(toMessage),
      redrive: (queueId: string, selection?: string | RedriveOptions) => {
        const options = typeof selection === "string" ? { messageId: selection } : selection ?? {};
        if (options.limit !== undefined && !(Number.isSafeInteger(options.limit) && options.limit >= 1))
          failWith(diagnosticCodes.operationInvalid, `Redriving queue "${queueId}" needs "limit" to be a whole number of at least 1, not ${String(options.limit)}.`);
        return store.redrive(queueChannel(queueId), {
          ...options.messageId === undefined ? {} : { id: options.messageId },
          ...options.limit === undefined ? {} : { limit: options.limit },
          ...options.newOperation === undefined ? {} : { newOperation: options.newOperation }
        });
      },
      duplicate: (queueId: string, messageId: string) => store.duplicate(queueChannel(queueId), messageId),
      purge: (queueId: string) => store.purge(queueChannel(queueId))
    })
  };
}