import type { AmqpQueueArguments } from "@/transport";

/**
 * The redelivery delays the delay-queue emulation offers, in seconds. A
 * requested delay is rounded up to the next one, so messages are never
 * delivered earlier than asked, at most this much later.
 */
export const delaySteps: readonly number[] = Object.freeze([1, 2, 5, 10, 30, 60, 120, 300, 600, 900]);

/** The longest delay the emulation offers, in seconds. */
export const maxDelaySeconds = delaySteps.at(-1)!;

/**
 * Returns the delay step that serves a delay: the smallest step at least as long.
 *
 * @param seconds - The requested delay, at least 1 and at most {@link maxDelaySeconds}.
 * @returns The step, in seconds.
 */
export function delayStep(seconds: number): number {
  return delaySteps.find(step => step >= seconds) ?? maxDelaySeconds;
}

/** The broker queues one Holqa queue uses. */
export interface QueueTopology {
  /** The queue consumers read from. */
  readonly queue: string;
  /** Where dead-lettered messages go, when dead-lettering is enabled. */
  readonly deadLetter?: string;
  /** The delay queues, by delay step in seconds, when delayed delivery is enabled. */
  readonly delays: Readonly<Record<number, string>>;
}

/** Settings of {@link queueTopology}. */
export interface TopologyOptions {
  readonly deadLetter: boolean;
  readonly delayQueues: boolean;
}

/**
 * Names the broker queues of one Holqa queue: `<queue>`, `<queue>.dead-letter`
 * and `<queue>.delay.<seconds>`.
 *
 * @param queue - The broker queue consumers read from.
 * @param options - Which parts are enabled.
 * @returns The broker queue names of the Holqa queue.
 */
export function queueTopology(queue: string, options: TopologyOptions): QueueTopology {
  return Object.freeze({
    queue,
    ...options.deadLetter ? { deadLetter: `${queue}.dead-letter` } : {},
    delays: Object.freeze(options.delayQueues ? Object.fromEntries(delaySteps.map(step => [step, `${queue}.delay.${step}`])) : {})
  });
}

/** One queue to declare, with its arguments. */
export interface QueueDeclaration {
  readonly queue: string;
  readonly arguments: AmqpQueueArguments;
  /** What the queue is for, for plans. */
  readonly purpose: "messages" | "dead-letter" | "delay";
}

/**
 * Lists the declarations of a topology. Delay queues expire messages after
 * their step and dead-letter them, through the default exchange, back into
 * the main queue; they have no consumers.
 *
 * @param topology - The broker queues of one Holqa queue.
 * @param queueType - The broker queue type of the main and dead-letter queues, `quorum` (recommended: it counts redeliveries) or `classic`.
 * @returns The declarations, main queue first.
 */
export function topologyDeclarations(topology: QueueTopology, queueType: "quorum" | "classic"): QueueDeclaration[] {
  return [
    { queue: topology.queue, arguments: { "x-queue-type": queueType }, purpose: "messages" },
    ...topology.deadLetter === undefined ? [] : [{ queue: topology.deadLetter, arguments: { "x-queue-type": queueType }, purpose: "dead-letter" as const }],
    ...Object.entries(topology.delays).map(([step, queue]) => ({
      queue,
      arguments: { "x-queue-type": "classic", "x-message-ttl": Number(step) * 1000, "x-dead-letter-exchange": "", "x-dead-letter-routing-key": topology.queue },
      purpose: "delay" as const
    }))
  ];
}