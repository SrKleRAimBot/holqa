import type { JsonObject } from "@holqa/experiment-model";

import type { Activity } from "@/drivers/activity";

import { experimentCodes } from "@holqa/experiment-model";

import {
  describeError,
  hasCode
} from "@/diagnostics";

/** How the runtime lets the queue driver reach the current generation. */
export interface QueuePort {
  /** The consumer handler of a queue in the current generation, if any. */
  readonly consumerFor: (queueId: string) => string | undefined;
  /** The declared delivery policy of a queue. */
  readonly policyFor: (queueId: string) => { readonly maxAttempts: number; readonly deadLetter: boolean };
  /** Invokes a consumer through the runtime, so concurrency limits and cancellation apply. */
  readonly deliver: (handlerId: string, message: unknown, metadata: JsonObject) => Promise<unknown>;
}

/** A message that exhausted its attempts or was rejected as invalid. */
export interface DeadLetter {
  readonly messageId: string;
  readonly message: unknown;
  readonly attempts: number;
  readonly reason: string;
}

/** A point-in-time view of one queue. */
export interface QueueSnapshot {
  readonly pending: number;
  readonly delivered: number;
  readonly dropped: number;
  readonly deadLetters: readonly DeadLetter[];
}

/** A message waiting for delivery. */
interface PendingMessage {
  readonly messageId: string;
  readonly body: string;
  readonly attempt: number;
}

/** Mutable state of one queue. */
interface QueueState {
  readonly pending: PendingMessage[];
  readonly deadLetters: DeadLetter[];
  delivered: number;
  dropped: number;
}

/**
 * An in-memory queue emulation with at-least-once semantics and no stronger
 * promises: a failed delivery is redelivered with an incremented attempt
 * number up to `maxAttempts`, after which the message is dead-lettered when the
 * queue declares `deadLetter`, and dropped (and counted) otherwise. Messages
 * that fail input validation are not retried, because retrying cannot fix
 * them. Delivery order is not guaranteed, redelivery is immediate (no
 * backoff), and state is lost when the process exits.
 *
 * Messages are stored JSON-encoded, as a production queue would store bytes,
 * so producers and consumers never share object references.
 */
export class InMemoryQueues {
  private readonly queues = new Map<string, QueueState>();
  private nextMessage = 0;

  /**
   * Creates the queue driver.
   *
   * @param port - Access to the current generation's consumers.
   * @param activity - Tracks deliveries for `idle()`.
   */
  constructor(private readonly port: QueuePort, private readonly activity: Activity) {}

  /**
   * Accepts a validated message and schedules its delivery.
   *
   * @param queueId - The queue identifier.
   * @param message - The message, which must be JSON-serializable.
   * @throws {TypeError} When the message cannot be JSON-encoded.
   */
  send(queueId: string, message: unknown): void {
    const body = JSON.stringify(message);
    if (body === undefined)
      throw new TypeError(`Queue "${queueId}" messages must be JSON-serializable.`);
    this.state(queueId).pending.push({ messageId: `msg-${++this.nextMessage}`, body, attempt: 1 });
    this.pump(queueId);
  }

  /** Starts delivering pending messages on every queue that has a consumer, for example after a reload. */
  pumpAll(): void {
    for (const queueId of this.queues.keys())
      this.pump(queueId);
  }

  /**
   * Returns a snapshot of one queue.
   *
   * @param queueId - The queue identifier.
   * @returns Counts and dead letters; empty for a queue that never received a message.
   */
  snapshot(queueId: string): QueueSnapshot {
    const state = this.state(queueId);
    return { pending: state.pending.length, delivered: state.delivered, dropped: state.dropped, deadLetters: [...state.deadLetters] };
  }

  /**
   * Returns the state of a queue, creating it on first use.
   *
   * @param queueId - The queue identifier.
   * @returns The mutable state.
   */
  private state(queueId: string): QueueState {
    let state = this.queues.get(queueId);
    if (state === undefined) {
      state = { pending: [], deadLetters: [], delivered: 0, dropped: 0 };
      this.queues.set(queueId, state);
    }
    return state;
  }

  /**
   * Hands every pending message of a queue to its consumer, if it has one.
   *
   * @param queueId - The queue identifier.
   */
  private pump(queueId: string): void {
    const consumer = this.port.consumerFor(queueId);
    if (consumer === undefined)
      return;
    const state = this.state(queueId);
    for (const message of state.pending.splice(0))
      void this.activity.track(async () => this.attempt(queueId, consumer, message));
  }

  /**
   * Delivers one message once and decides what happens on failure.
   *
   * @param queueId - The queue identifier.
   * @param consumer - The consumer handler identifier.
   * @param message - The pending message.
   */
  private async attempt(queueId: string, consumer: string, message: PendingMessage): Promise<void> {
    const state = this.state(queueId);
    try {
      await this.port.deliver(consumer, JSON.parse(message.body), { attempt: message.attempt, messageId: message.messageId });
      state.delivered += 1;
    } catch (error) {
      if (hasCode(error, experimentCodes.runtimeDisposed) || hasCode(error, experimentCodes.handlerNotFound)) {
        // Never acknowledged: keep it for a later generation or process.
        state.pending.push(message);
        return;
      }
      const policy = this.port.policyFor(queueId);
      const invalid = hasCode(error, experimentCodes.inputInvalid);
      if (!invalid && message.attempt < policy.maxAttempts) {
        state.pending.push({ ...message, attempt: message.attempt + 1 });
        this.pump(queueId);
        return;
      }
      if (policy.deadLetter)
        state.deadLetters.push({ messageId: message.messageId, message: JSON.parse(message.body), attempts: message.attempt, reason: describeError(error) });
      else
        state.dropped += 1;
    }
  }
}