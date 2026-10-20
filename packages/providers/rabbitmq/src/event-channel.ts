import type {
  BindingStopOptions,
  CredentialReference,
  DeliverySource,
  EventChannel,
  OpenedEventChannel,
  ProviderContext
} from "@holqa/core";

import type {
  AmqpTransport,
  RabbitMqTransportOptions
} from "@/transport";

import {
  bindingFailure,
  HolqaError,
  isCredentialReference
} from "@holqa/core";

import { createLeasedBinding } from "@/queue";
import {
  queueTopology,
  topologyDeclarations
} from "@/topology";
import { rabbitMqTransport } from "@/transport";

/** Settings of {@link rabbitmq.eventChannel}. */
export interface RabbitMqEventChannelOptions {
  /** The AMQP URL, with credentials, as a credential reference. */
  readonly url: CredentialReference;
  /**
   * Prepended to subscription names to name their queues. Each subscription
   * (one object event handler) has its own queue, bound by provisioning to the
   * exchange the store publishes notifications to. Default `holqa.events.`.
   */
  readonly queuePrefix?: string;
  /** The exchange the store publishes to, recorded for provisioning and inspection. Default `holqa.storage-events`. */
  readonly exchange?: string;
  /** Redelivery delays through delay queues, as for queues. Object event retries need it. Default `delay-queues`. */
  readonly delayedDelivery?: "delay-queues" | "none";
  /** Whether each subscription has a dead-letter queue. Default `true`. */
  readonly deadLetter?: boolean;
  readonly prefetch?: number;
  readonly connectTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Creates the transport; replaceable in tests. */
  readonly transport?: (url: string, options: RabbitMqTransportOptions) => AmqpTransport;
}

/**
 * Creates an event channel on RabbitMQ: raw storage notifications (for
 * example the S3 event records MinIO and other stores publish to an AMQP
 * exchange) delivered per subscription, with leases, retries through delay
 * queues and dead-lettering, like queue messages. A storage provider such as
 * `s3.buckets({ events: { channel } })` opens it and turns the notifications
 * into object events.
 *
 * Like the queue provider it never creates queues, exchanges or bindings:
 * attaching to a subscription whose queue is missing fails with
 * `HOLQA_BINDING_FAILED`.
 *
 * @param options - URL reference, naming and limits.
 * @returns A channel a storage provider opens to subscribe to notifications.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` for invalid settings.
 */
export function eventChannel(options: RabbitMqEventChannelOptions): EventChannel {
  const problems: string[] = [];
  if (!isCredentialReference(options.url))
    problems.push("\"url\" must be a credential reference.");
  if (options.queuePrefix !== undefined && !/^[\w.:-]{0,100}$/.test(options.queuePrefix))
    problems.push("\"queuePrefix\" must be letters, digits, \"_\", \".\", \":\" or \"-\".");
  if (options.delayedDelivery !== undefined && options.delayedDelivery !== "delay-queues" && options.delayedDelivery !== "none")
    problems.push("\"delayedDelivery\" must be \"delay-queues\" or \"none\".");
  if (problems.length > 0)
    throw new HolqaError(problems.map(problem => bindingFailure("configuration", { binding: "rabbitmq.events", message: `rabbitmq.eventChannel: ${problem}` })));
  const prefix = options.queuePrefix ?? "holqa.events.";
  const exchange = options.exchange ?? "holqa.storage-events";
  const delayQueues = (options.delayedDelivery ?? "delay-queues") === "delay-queues";
  const deadLetter = options.deadLetter ?? true;
  return Object.freeze({
    channel: "holqa.rabbitmq.events",
    description: `RabbitMQ (exchange "${exchange}", one queue per subscription named "${prefix}<bucket>.<handler>")`,
    settings: Object.freeze({ queuePrefix: prefix, exchange, delayedDelivery: delayQueues ? "delay-queues" : "none", deadLetter }),
    credentials: Object.freeze([options.url]),
    open: async (context: ProviderContext): Promise<OpenedEventChannel> => {
      const transport = (options.transport ?? rabbitMqTransport)(context.credential(options.url), { binding: "rabbitmq.events" });
      await transport.connect(options.connectTimeoutMs ?? 10_000);
      const bindings: Array<ReturnType<typeof createLeasedBinding<Uint8Array>>> = [];
      return Object.freeze({
        subscribe: async (subscription: string): Promise<DeliverySource<Uint8Array>> => {
          const topology = queueTopology(`${prefix}${subscription}`, { deadLetter, delayQueues });
          const missing: string[] = [];
          for (const declaration of topologyDeclarations(topology, "quorum")) {
            if (await transport.inspect(declaration.queue) === undefined)
              missing.push(declaration.queue);
          }
          if (missing.length > 0)
            throw new HolqaError(bindingFailure("failed", { binding: "rabbitmq.events", message: `The notification queues ${missing.join(", ")} do not exist.`, hint: `Create them and bind "${topology.queue}" to the exchange "${exchange}" before starting.`, details: { queues: missing } }));
          const binding = createLeasedBinding<Uint8Array>({
            binding: "rabbitmq.events",
            transport,
            topology,
            prefetch: options.prefetch ?? 16,
            defaultMaxAttempts: 5,
            createId: () => crypto.randomUUID(),
            now: () => Date.now(),
            setTimer: (delayMs, callback) => {
              const timer = setTimeout(callback, delayMs);
              return () => clearTimeout(timer);
            },
            pollIntervalMs: options.pollIntervalMs ?? 1_000,
            log: context.log
          }, body => body);
          bindings.push(binding);
          return binding.source;
        },
        health: async () => transport.connected() ? { status: "healthy" as const } : { status: "degraded" as const, message: "Reconnecting to the broker." },
        stop: async ({ signal }: BindingStopOptions) => {
          const stopping = Promise.all(bindings.map(binding => binding.stop())).then(() => transport.close());
          await Promise.race([stopping, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
        }
      });
    }
  });
}