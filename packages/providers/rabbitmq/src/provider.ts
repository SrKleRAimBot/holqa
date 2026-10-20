import type {
  BindingProvider,
  BindingStopOptions,
  CapabilityEmulation,
  CredentialReference,
  JsonObject,
  ProviderContext,
  ProviderInstance,
  QueueCapabilities,
  QueueDriver,
  QueueSource,
  ResourceDescriptorOf
} from "@holqa/core";

import type { QueueTopology } from "@/topology";
import type {
  AmqpTransport,
  RabbitMqTransportOptions
} from "@/transport";

import {
  bindingFailure,
  bindingProtocolVersion,
  HolqaError,
  isCredentialReference
} from "@holqa/core";

import { eventChannel } from "@/event-channel";
import { createQueueBinding } from "@/queue";
import {
  delaySteps,
  maxDelaySeconds,
  queueTopology,
  topologyDeclarations
} from "@/topology";
import { rabbitMqTransport } from "@/transport";

/** Settings of {@link rabbitmq.queues}. */
export interface RabbitMqQueuesOptions {
  /** The AMQP URL, with credentials, as a credential reference: `credentialRef("QUEUE_URL")`. */
  readonly url: CredentialReference;
  /** The provider's name. Default `rabbitmq`. */
  readonly name?: string;
  /** Broker queue names by Holqa queue identifier. Queues not listed use `<prefix><identifier>`. */
  readonly queues?: Readonly<Record<string, string>>;
  /** Prepended to Holqa queue identifiers to name broker queues. Default empty. */
  readonly prefix?: string;
  /**
   * How delayed sends and redeliveries are implemented. RabbitMQ has no
   * native delayed delivery, so it must be enabled explicitly:
   * `delay-queues` uses one queue per delay step whose messages expire into
   * the main queue (an emulation, reported by inspection); `none` (default)
   * advertises no delays, so queues need a binding that can delay, or they fail validation.
   */
  readonly delayedDelivery?: "delay-queues" | "none";
  /** Whether a dead-letter queue (`<queue>.dead-letter`) is used. Default `true`. */
  readonly deadLetter?: boolean;
  /** The broker queue type provisioning declares. `quorum` (default) also counts redeliveries after crashes exactly. */
  readonly queueType?: "quorum" | "classic";
  /** The most unsettled messages per queue held by this process. Default 16. */
  readonly prefetch?: number;
  /** The most delivery attempts a queue may declare. Default 25. */
  readonly maxAttempts?: number;
  /** Attempts of queues that declare none. Default 5. */
  readonly defaultMaxAttempts?: number;
  /** The largest message accepted, in bytes of the serialized envelope. Default 16 MiB (RabbitMQ 4's default limit). */
  readonly maxMessageBytes?: number;
  /** How long to wait for the broker when starting, in milliseconds. Default 10 000. */
  readonly connectTimeoutMs?: number;
  /** How often an idle receiver checks for work, in milliseconds. Default 1 000. */
  readonly pollIntervalMs?: number;
  /** The time source of leases and polling. Default the wall clock; tests use a virtual one. */
  readonly clock?: {
    readonly now: () => number;
    readonly setTimer: (delayMs: number, callback: () => void) => () => void;
  };
  /** Creates the transport; replaceable in tests. Default: `rabbitmq-client`. */
  readonly transport?: (url: string, options: RabbitMqTransportOptions) => AmqpTransport;
}

/** Matches a broker queue name: printable ASCII without spaces, not reserved by the broker. */
const queueNamePattern = /^(?!amq\.)[\w.:-]{1,200}$/;

/**
 * Validates the settings of the queue provider.
 *
 * @param options - The untrusted settings.
 * @param name - The provider's name, for messages.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID`, one diagnostic per problem.
 */
function checkOptions(options: RabbitMqQueuesOptions, name: string): void {
  const problems: string[] = [];
  /**
   * Records a problem unless a value is absent or a positive whole number.
   *
   * @param value - The candidate.
   * @param setting - The setting's name.
   */
  const positive = (value: unknown, setting: string): void => {
    if (value !== undefined && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 1))
      problems.push(`"${setting}" must be a whole number of at least 1.`);
  };
  if (!isCredentialReference(options.url))
    problems.push("\"url\" must be a credential reference, for example credentialRef(\"QUEUE_URL\"); URLs carry credentials and never appear in configurations.");
  if (options.delayedDelivery !== undefined && options.delayedDelivery !== "delay-queues" && options.delayedDelivery !== "none")
    problems.push("\"delayedDelivery\" must be \"delay-queues\" or \"none\".");
  if (options.queueType !== undefined && options.queueType !== "quorum" && options.queueType !== "classic")
    problems.push("\"queueType\" must be \"quorum\" or \"classic\".");
  if (options.deadLetter !== undefined && typeof options.deadLetter !== "boolean")
    problems.push("\"deadLetter\" must be a boolean.");
  if (options.prefix !== undefined && !(typeof options.prefix === "string" && (options.prefix === "" || /^[\w.:-]{1,50}$/.test(options.prefix))))
    problems.push("\"prefix\" must be letters, digits, \"_\", \".\", \":\" or \"-\".");
  for (const [id, queue] of Object.entries(options.queues ?? {})) {
    if (typeof queue !== "string" || !queueNamePattern.test(queue))
      problems.push(`"queues.${id}" must be a broker queue name of at most 200 characters, without spaces, not starting with "amq.".`);
  }
  positive(options.prefetch, "prefetch");
  positive(options.maxAttempts, "maxAttempts");
  positive(options.defaultMaxAttempts, "defaultMaxAttempts");
  positive(options.maxMessageBytes, "maxMessageBytes");
  positive(options.connectTimeoutMs, "connectTimeoutMs");
  positive(options.pollIntervalMs, "pollIntervalMs");
  if (options.defaultMaxAttempts !== undefined && options.maxAttempts !== undefined && options.defaultMaxAttempts > options.maxAttempts)
    problems.push("\"defaultMaxAttempts\" must not exceed \"maxAttempts\".");
  if (problems.length > 0)
    throw new HolqaError(problems.map(problem => bindingFailure("configuration", { binding: name, message: `rabbitmq.queues: ${problem}` })));
}

/**
 * Creates a RabbitMQ queue provider: Holqa queues on broker queues, reached
 * with the credentials of one AMQP URL.
 *
 * It needs only data-plane permissions: publishing to and consuming from
 * the configured queues (and their delay and dead-letter queues), and a
 * passive declaration to check that they exist. It never creates or deletes
 * queues; provisioning or other tooling does that. Starting fails
 * with `HOLQA_BINDING_FAILED` when a queue is missing,
 * `HOLQA_BINDING_CREDENTIALS_INVALID` when the broker rejects the login, and
 * `HOLQA_BINDING_UNAVAILABLE` when it cannot be reached.
 *
 * @example
 * ```ts
 * rabbitmq.queues({ url: credentialRef("QUEUE_URL"), delayedDelivery: "delay-queues" });
 * ```
 *
 * @param options - URL reference, queue names, delay emulation and limits.
 * @returns A resource provider for queues.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` for invalid settings.
 */
function queues(options: RabbitMqQueuesOptions): BindingProvider<"queue"> {
  const name = options.name ?? "rabbitmq";
  checkOptions(options, name);
  const delayQueues = options.delayedDelivery === "delay-queues";
  const deadLetter = options.deadLetter ?? true;
  const queueType = options.queueType ?? "quorum";
  const maxAttempts = options.maxAttempts ?? 25;
  const capabilities: QueueCapabilities = Object.freeze({
    delivery: Object.freeze(["at-least-once" as const]),
    maxAttempts,
    deadLetter,
    maxMessageBytes: options.maxMessageBytes ?? 16 * 1024 * 1024,
    ...delayQueues ? { backoff: Object.freeze(["fixed" as const, "exponential" as const]), maxDelaySeconds } : {}
  });
  const mechanism = `delay queues whose messages expire after a fixed step and dead-letter back into the main queue; delays round up to the next step (${delaySteps.join(", ")} seconds)`;
  const emulations: readonly CapabilityEmulation[] = delayQueues
    ? Object.freeze(["queue.delay", "queue.backoff.fixed", "queue.backoff.exponential"].map(capability => Object.freeze({ kind: "queue" as const, capability, mechanism, requires: Object.freeze([`${delaySteps.length} delay queues per Holqa queue (<queue>.delay.<seconds>), created by provisioning`]) })))
    : [];
  /**
   * Names the broker queue of a Holqa queue.
   *
   * @param id - The Holqa queue's identifier.
   * @returns The broker queue name.
   */
  const brokerQueue = (id: string): string => options.queues?.[id] ?? `${options.prefix ?? ""}${id}`;
  /**
   * Returns the broker topology of a Holqa queue.
   *
   * @param id - The Holqa queue's identifier.
   * @returns Its queue, dead-letter queue and delay queues.
   */
  const topologyOf = (id: string): QueueTopology => queueTopology(brokerQueue(id), { deadLetter, delayQueues });
  const settings: JsonObject = Object.freeze({
    delayedDelivery: delayQueues ? "delay-queues" : "none",
    deadLetter,
    queueType,
    prefetch: options.prefetch ?? 16,
    ...options.prefix === undefined ? {} : { prefix: options.prefix },
    ...options.queues === undefined ? {} : { queues: Object.freeze({ ...options.queues }) }
  });

  return Object.freeze({
    bindingProtocol: bindingProtocolVersion,
    provider: "holqa.rabbitmq",
    name,
    role: "resource",
    contracts: Object.freeze({ queue: 1 }),
    resources: Object.freeze({ queue: capabilities }),
    services: Object.freeze({}),
    emulations,
    topology: Object.freeze({ delivery: "pull", state: "shared", connectors: Object.freeze(["a long-running application process (or worker) that consumes the broker queues"]) }),
    settings,
    credentials: Object.freeze([options.url]),
    /**
     * Connects to the broker and checks that every queue's topology exists.
     *
     * @param context - The provider context.
     * @returns The instance with drivers, sources and lifecycle hooks.
     */
    open: async (context: ProviderContext): Promise<ProviderInstance> => {
      const url = context.credential(options.url);
      const transport = (options.transport ?? rabbitMqTransport)(url, { binding: name });
      const bindings = new Map<string, ReturnType<typeof createQueueBinding>>();
      try {
        await transport.connect(options.connectTimeoutMs ?? 10_000);
        const missing: string[] = [];
        for (const resource of context.resources) {
          if (resource.kind !== "queue")
            continue;
          for (const declaration of topologyDeclarations(topologyOf(resource.id), queueType)) {
            if (await transport.inspect(declaration.queue) === undefined)
              missing.push(declaration.queue);
          }
        }
        if (missing.length > 0)
          throw new HolqaError(bindingFailure("failed", { binding: name, message: `The broker queues ${missing.join(", ")} do not exist.`, hint: "Create them before starting, with your own tooling or a provisioning step; runtime credentials never create queues.", details: { queues: missing } }));
      } catch (error) {
        await transport.close().catch(() => {});
        throw error;
      }
      /**
       * Returns the binding of one queue, creating it once.
       *
       * @param resource - The queue.
       * @returns Its driver, source and stop function.
       */
      const bindingOf = (resource: ResourceDescriptorOf<"queue">): ReturnType<typeof createQueueBinding> => {
        let binding = bindings.get(resource.id);
        if (binding === undefined) {
          binding = createQueueBinding({
            binding: name,
            transport,
            topology: topologyOf(resource.id),
            prefetch: options.prefetch ?? 16,
            defaultMaxAttempts: options.defaultMaxAttempts ?? 5,
            createId: () => crypto.randomUUID(),
            now: options.clock?.now ?? (() => Date.now()),
            setTimer: options.clock?.setTimer ?? ((delayMs, callback) => {
              const timer = setTimeout(callback, delayMs);
              return () => clearTimeout(timer);
            }),
            pollIntervalMs: options.pollIntervalMs ?? 1_000,
            log: context.log
          });
          bindings.set(resource.id, binding);
        }
        return binding;
      };
      return Object.freeze({
        drivers: Object.freeze({ queue: (resource: ResourceDescriptorOf<"queue">): QueueDriver => bindingOf(resource).driver }),
        sources: Object.freeze({ queue: (resource: ResourceDescriptorOf<"queue">): QueueSource => bindingOf(resource).source }),
        ready: async () => {
          if (!transport.connected())
            throw new HolqaError(bindingFailure("unavailable", { binding: name, message: "The broker connection was lost while starting." }));
        },
        health: async () => transport.connected()
          ? { status: "healthy" as const, details: { queues: bindings.size } }
          : { status: "degraded" as const, message: "Reconnecting to the broker; operations fail until the connection is back.", details: { queues: bindings.size } },
        stop: async ({ signal }: BindingStopOptions) => {
          const stopping = Promise.all([...bindings.values()].map(binding => binding.stop())).then(() => transport.close());
          await Promise.race([stopping, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
        }
      });
    }
  });
}

/** RabbitMQ binding providers: queues, and an event channel for storage notifications. */
export const rabbitmq = Object.freeze({ queues, eventChannel });