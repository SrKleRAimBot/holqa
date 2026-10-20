import type {
  AmqpConsumer,
  AmqpMessage,
  AmqpPublishProperties,
  AmqpQueueArguments,
  AmqpSettlement,
  AmqpTransport
} from "@/transport";

import {
  bindingFailure,
  HolqaError
} from "@holqa/core";

/** A virtual clock: timers fire only when time is advanced. */
export class VirtualClock {
  private time = Date.UTC(2026, 0, 1);
  private timers: Array<{ due: number; callback: () => void; id: number }> = [];
  private sequence = 0;

  /**
   * Returns the current virtual time.
   *
   * @returns Epoch milliseconds.
   */
  readonly now = (): number => this.time;

  /**
   * Calls a function after a delay of virtual time.
   *
   * @param delayMs - How much virtual time passes before the call.
   * @param callback - What to call.
   * @returns A function that cancels the timer.
   */
  readonly setTimer = (delayMs: number, callback: () => void): (() => void) => {
    const id = ++this.sequence;
    this.timers.push({ due: this.time + Math.max(0, delayMs), callback, id });
    return () => {
      this.timers = this.timers.filter(timer => timer.id !== id);
    };
  };

  /**
   * Moves time forward, firing due timers in order and letting their work run.
   *
   * @param ms - How much time passes.
   */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const next = this.timers.filter(timer => timer.due <= end).sort((left, right) => left.due - right.due || left.id - right.id)[0];
      if (next === undefined)
        break;
      this.timers = this.timers.filter(timer => timer.id !== next.id);
      this.time = next.due;
      next.callback();
      await Bun.sleep(0);
    }
    this.time = end;
    await Bun.sleep(1);
  }
}

/** A message stored in a queue. */
interface Stored {
  readonly body: Uint8Array;
  readonly messageId: string;
  readonly headers: Readonly<Record<string, string | number>>;
  redelivered: boolean;
}

/** A queue of the broker. */
interface BrokerQueue {
  readonly args: AmqpQueueArguments;
  readonly ready: Stored[];
}

/**
 * An in-memory AMQP broker with the semantics the queue provider relies on:
 * durable queues, the default exchange, per-queue message expiry that
 * dead-letters to a routing key, prefetch-bounded consumers, acknowledgement
 * and requeue (redelivered), and connection drops that requeue unsettled
 * messages. It also injects faults.
 */
export class MemoryBroker {
  readonly queues = new Map<string, BrokerQueue>();
  readonly clock: VirtualClock;
  /** Publishes to fail next, as a broker that drops the connection would. */
  failPublishes = 0;
  /** Makes connecting fail with this failure kind. */
  connectFailure: "credentials-invalid" | "unavailable" | undefined;
  private generationValue = 1;
  private online = true;
  private consumers: Array<{ queue: string; prefetch: number; handler: (message: AmqpMessage, generation: number) => Promise<AmqpSettlement>; inFlight: Set<Stored>; closed: boolean }> = [];

  /**
   * Creates a broker on a virtual clock.
   *
   * @param clock - The clock that drives message expiry.
   */
  constructor(clock = new VirtualClock()) {
    this.clock = clock;
  }

  /**
   * Declares a queue directly, as provisioning would.
   *
   * @param queue - The name.
   * @param args - Its arguments.
   */
  declare(queue: string, args: AmqpQueueArguments = {}): void {
    if (!this.queues.has(queue))
      this.queues.set(queue, { args, ready: [] });
  }

  /** Drops the connection: unsettled messages return to their queues, and the transport reconnects with a new generation. */
  dropConnection(): void {
    this.generationValue += 1;
    for (const consumer of this.consumers) {
      for (const message of consumer.inFlight) {
        message.redelivered = true;
        this.queues.get(consumer.queue)?.ready.unshift(message);
      }
      consumer.inFlight.clear();
    }
    this.pump();
  }

  /** Takes the broker offline until {@link restore}. */
  goOffline(): void {
    this.online = false;
  }

  /** Brings the broker back online, reconnecting. */
  restore(): void {
    this.online = true;
    this.dropConnection();
  }

  /**
   * Lists the messages ready in a queue.
   *
   * @param queue - The name.
   * @returns The messages, oldest first.
   */
  messages(queue: string): ReadonlyArray<{ readonly messageId: string; readonly headers: Readonly<Record<string, string | number>> }> {
    return this.queues.get(queue)?.ready ?? [];
  }

  /**
   * Creates a transport connected to this broker.
   *
   * @param binding - The provider's name, for failures.
   * @returns A transport that sees this broker's queues.
   */
  transport(binding: string): AmqpTransport {
    return Object.freeze({
      connect: async () => {
        if (this.connectFailure !== undefined)
          throw new HolqaError(bindingFailure(this.connectFailure, { binding, message: "Injected connection failure." }));
      },
      publish: async (queue: string, body: Uint8Array, properties: AmqpPublishProperties) => {
        if (!this.online || this.failPublishes > 0) {
          this.failPublishes = Math.max(0, this.failPublishes - 1);
          throw new HolqaError(bindingFailure("unavailable", { binding, message: "Injected publish failure." }));
        }
        const target = this.queues.get(queue);
        if (target === undefined)
          throw new HolqaError(bindingFailure("failed", { binding, message: `No queue "${queue}".` }));
        const message: Stored = { body: body.slice(), messageId: properties.messageId, headers: { ...properties.headers }, redelivered: false };
        target.ready.push(message);
        const ttl = target.args["x-message-ttl"];
        if (typeof ttl === "number") {
          this.clock.setTimer(ttl, () => {
            const index = target.ready.indexOf(message);
            if (index === -1)
              return;
            target.ready.splice(index, 1);
            const route = target.args["x-dead-letter-routing-key"];
            if (typeof route === "string")
              this.queues.get(route)?.ready.push({ ...message, redelivered: false });
            this.pump();
          });
        }
        this.pump();
      },
      consume: async (queue: string, prefetch: number, handler: (message: AmqpMessage, generation: number) => Promise<AmqpSettlement>): Promise<AmqpConsumer> => {
        if (!this.queues.has(queue))
          throw new HolqaError(bindingFailure("failed", { binding, message: `No queue "${queue}".` }));
        const consumer = { queue, prefetch, handler, inFlight: new Set<Stored>(), closed: false };
        this.consumers.push(consumer);
        this.pump();
        return Object.freeze({
          close: async () => {
            consumer.closed = true;
            for (const message of consumer.inFlight) {
              message.redelivered = true;
              this.queues.get(queue)?.ready.unshift(message);
            }
            consumer.inFlight.clear();
            this.consumers = this.consumers.filter(candidate => candidate !== consumer);
          }
        });
      },
      inspect: async (queue: string) => {
        const found = this.queues.get(queue);
        return found === undefined ? undefined : { messageCount: found.ready.length };
      },
      declare: async (queue: string, args: AmqpQueueArguments) => this.declare(queue, args),
      remove: async (queue: string) => {
        this.queues.delete(queue);
      },
      generation: () => this.generationValue,
      connected: () => this.online,
      close: async () => {
        for (const consumer of [...this.consumers]) {
          consumer.closed = true;
          for (const message of consumer.inFlight) {
            message.redelivered = true;
            this.queues.get(consumer.queue)?.ready.unshift(message);
          }
          consumer.inFlight.clear();
        }
        this.consumers = [];
      }
    });
  }

  /** Hands ready messages to consumers with free prefetch capacity. */
  private pump(): void {
    if (!this.online)
      return;
    for (const consumer of this.consumers) {
      const queue = this.queues.get(consumer.queue);
      if (queue === undefined)
        continue;
      for (;;) {
        if (consumer.closed || consumer.inFlight.size >= consumer.prefetch || queue.ready.length === 0)
          break;
        const message = queue.ready.shift()!;
        consumer.inFlight.add(message);
        const generation = this.generationValue;
        void consumer.handler({ body: message.body, messageId: message.messageId, headers: message.headers, redelivered: message.redelivered }, generation).then((settlement) => {
          // A settlement on a dropped connection has no effect: the broker already requeued the message.
          if (generation !== this.generationValue || !consumer.inFlight.has(message))
            return;
          consumer.inFlight.delete(message);
          if (settlement === "requeue") {
            message.redelivered = true;
            queue.ready.unshift(message);
          }
          this.pump();
        });
      }
    }
  }
}