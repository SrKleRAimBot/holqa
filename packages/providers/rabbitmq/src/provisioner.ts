import type {
  AnyBindingProvider,
  AppliedChange,
  CredentialReference,
  Diagnostic,
  JsonObject,
  PlannedChange,
  Provisioner,
  ProvisioningContext,
  ResourceDescriptor
} from "@holqa/core";

import type { QueueDeclaration } from "@/topology";
import type {
  AmqpExchangeType,
  AmqpTransport,
  RabbitMqTransportOptions
} from "@/transport";

import {
  bindingFailure,
  HolqaError,
  isCredentialReference,
  provisioningProtocolVersion
} from "@holqa/core";

import {
  queueTopology,
  topologyDeclarations
} from "@/topology";
import { rabbitMqTransport } from "@/transport";

/** Settings of {@link rabbitmq.provisioner}. */
export interface RabbitMqProvisionerOptions {
  /** The AMQP URL of an account allowed to declare queues, exchanges and bindings, as a credential reference. The runtime never needs it. */
  readonly url: CredentialReference;
  /** The provisioner's name. Default `rabbitmq.provisioner`. */
  readonly name?: string;
  /** Only provision for the runtime providers with these names, when several brokers are used. Default every RabbitMQ provider. */
  readonly providers?: readonly string[];
  /** The type of the storage notification exchange. Default `fanout`. */
  readonly exchangeType?: AmqpExchangeType;
  /** The routing key subscription queues are bound with. Default empty, which a `fanout` exchange ignores. */
  readonly routingKey?: string;
  readonly connectTimeoutMs?: number;
  /** Creates the transport; replaceable in tests. */
  readonly transport?: (url: string, options: RabbitMqTransportOptions) => AmqpTransport;
}

/** The fields of the queue provider's settings the provisioner reads. */
interface QueueSettings {
  readonly delayedDelivery?: string;
  readonly deadLetter?: boolean;
  readonly queueType?: "quorum" | "classic";
  readonly prefix?: string;
  readonly queues?: Readonly<Record<string, string>>;
}

/** The fields of an event channel's settings the provisioner reads. */
interface ChannelSettings {
  readonly queuePrefix?: string;
  readonly exchange?: string;
  readonly delayedDelivery?: string;
  readonly deadLetter?: boolean;
}

/** Desired infrastructure: queues, exchanges and bindings, in creation order. */
interface Desired {
  readonly queues: Array<QueueDeclaration & { readonly resource: string }>;
  readonly exchanges: Map<string, string>;
  readonly bindings: Array<{ readonly queue: string; readonly exchange: string; readonly resource: string }>;
}

/**
 * Reads the event channel settings of a storage provider that delivers
 * object events through a RabbitMQ event channel.
 *
 * @param provider - A bucket provider.
 * @returns The channel's settings, or `undefined` when it uses no RabbitMQ channel.
 */
function rabbitChannelOf(provider: AnyBindingProvider): ChannelSettings | undefined {
  const events = (provider.settings as { readonly events?: { readonly channel?: unknown; readonly channelSettings?: ChannelSettings } } | undefined)?.events;
  return events?.channel === "holqa.rabbitmq.events" ? events.channelSettings ?? {} : undefined;
}

/**
 * Computes the infrastructure the claimed resources need: each queue's
 * topology (main, dead-letter and delay queues), and for buckets with a
 * RabbitMQ event channel the notification exchange and one queue topology
 * per object event handler, bound to the exchange.
 *
 * @param context - The provisioning context.
 * @param claimed - Whether a provider is one this provisioner manages.
 * @returns The desired queues, exchanges and bindings.
 */
function desiredOf(context: ProvisioningContext, claimed: (provider: AnyBindingProvider) => boolean): Desired {
  const desired: Desired = { queues: [], exchanges: new Map(), bindings: [] };
  const seen = new Set<string>();
  /**
   * Adds a queue topology's declarations once.
   *
   * @param declarations - A queue topology's queue declarations.
   * @param resource - The Holqa resource they serve.
   */
  const add = (declarations: readonly QueueDeclaration[], resource: string): void => {
    for (const declaration of declarations) {
      if (!seen.has(declaration.queue)) {
        seen.add(declaration.queue);
        desired.queues.push({ ...declaration, resource });
      }
    }
  };
  for (const { resource, provider } of context.resources) {
    if (!claimed(provider))
      continue;
    if (resource.kind === "queue" && provider.provider === "holqa.rabbitmq") {
      const settings = (provider.settings ?? {}) as QueueSettings;
      const queue = settings.queues?.[resource.id] ?? `${settings.prefix ?? ""}${resource.id}`;
      add(topologyDeclarations(queueTopology(queue, { deadLetter: settings.deadLetter ?? true, delayQueues: settings.delayedDelivery === "delay-queues" }), settings.queueType ?? "quorum"), resource.id);
      continue;
    }
    const channel = resource.kind === "bucket" ? rabbitChannelOf(provider) : undefined;
    if (channel === undefined)
      continue;
    const exchange = channel.exchange ?? "holqa.storage-events";
    desired.exchanges.set(exchange, resource.id);
    for (const handler of context.handlers) {
      if ((handler.trigger.kind !== "bucket.object-created" && handler.trigger.kind !== "bucket.object-deleted") || handler.trigger.resource.id !== resource.id)
        continue;
      const topology = queueTopology(`${channel.queuePrefix ?? "holqa.events."}${resource.id}.${handler.id}`, { deadLetter: channel.deadLetter ?? true, delayQueues: (channel.delayedDelivery ?? "delay-queues") === "delay-queues" });
      add(topologyDeclarations(topology, "quorum"), resource.id);
      desired.bindings.push({ queue: topology.queue, exchange, resource: resource.id });
    }
  }
  return desired;
}

/**
 * Creates a provisioner for RabbitMQ: it declares the queues the RabbitMQ
 * queue provider expects (each queue with its dead-letter and delay queues
 * and their arguments), and for buckets whose object events arrive through
 * `rabbitmq.eventChannel`, the notification exchange and one queue topology
 * per object event handler, bound to it. Configuring the object store to
 * publish to the exchange is the store's provisioner's part.
 *
 * Plans read only: a queue or exchange is `create` when missing, `none` when
 * it matches, and `replace` (destructive) when it exists with other
 * arguments, which RabbitMQ cannot change in place. Bindings cannot be read
 * over AMQP 0-9-1, so each is planned as an idempotent `update`, or `create`
 * with its queue. Queues are never deleted because a resource was removed.
 *
 * @example
 * ```ts
 * defineProvisioning(bindings, { provisioners: [rabbitmq.provisioner({ url: credentialRef("RABBITMQ_ADMIN_URL") })] });
 * ```
 *
 * @param options - Administrative URL reference, scope and exchange settings.
 * @returns A provisioner for queues and storage event subscriptions.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` for invalid settings.
 */
export function provisioner(options: RabbitMqProvisionerOptions): Provisioner {
  const name = options.name ?? "rabbitmq.provisioner";
  const problems: string[] = [];
  if (!isCredentialReference(options.url))
    problems.push("\"url\" must be a credential reference.");
  if (options.exchangeType !== undefined && !["fanout", "direct", "topic"].includes(options.exchangeType))
    problems.push("\"exchangeType\" must be \"fanout\", \"direct\" or \"topic\".");
  if (options.providers !== undefined && !(Array.isArray(options.providers) && options.providers.every(provider => typeof provider === "string")))
    problems.push("\"providers\" must list provider names.");
  if (problems.length > 0)
    throw new HolqaError(problems.map(problem => bindingFailure("configuration", { binding: name, message: `rabbitmq.provisioner: ${problem}` })));
  const exchangeType = options.exchangeType ?? "fanout";
  const routingKey = options.routingKey ?? "";
  /**
   * Reports whether a runtime provider is in this provisioner's scope.
   *
   * @param provider - A selected provider.
   * @returns `true` when its infrastructure is managed here.
   */
  const claimed = (provider: AnyBindingProvider): boolean => options.providers === undefined || options.providers.includes(provider.name);
  /**
   * Connects to the broker with the administrative URL.
   *
   * @param context - The provisioning context, for the credential.
   * @returns The connected transport, with the administrative operations.
   * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` when the transport lacks administrative operations.
   */
  const connect = async (context: ProvisioningContext): Promise<Required<AmqpTransport>> => {
    const transport = (options.transport ?? rabbitMqTransport)(context.credential(options.url), { binding: name });
    if (transport.checkQueue === undefined || transport.checkExchange === undefined || transport.declareExchange === undefined || transport.bindQueue === undefined || transport.removeExchange === undefined)
      throw new HolqaError(bindingFailure("configuration", { binding: name, message: "The AMQP transport has no administrative operations." }));
    await transport.connect(options.connectTimeoutMs ?? 10_000);
    return transport as Required<AmqpTransport>;
  };
  /**
   * Builds one planned change.
   *
   * @param change - The change without the provisioner's name and the destructive flag.
   * @returns The change.
   */
  const planned = (change: Omit<PlannedChange, "provisioner" | "destructive">): PlannedChange => Object.freeze({ provisioner: name, ...change, destructive: change.action === "replace" || change.action === "delete" });

  return Object.freeze({
    provisioningProtocol: provisioningProtocolVersion,
    provisioner: "holqa.rabbitmq.provisioner",
    name,
    settings: Object.freeze({ exchangeType, routingKey, ...options.providers === undefined ? {} : { providers: Object.freeze([...options.providers]) } }),
    credentials: Object.freeze([options.url]),
    supports: (provider: AnyBindingProvider, resource: ResourceDescriptor) => claimed(provider) && ((resource.kind === "queue" && provider.provider === "holqa.rabbitmq") || (resource.kind === "bucket" && rabbitChannelOf(provider) !== undefined)),
    plan: async (context: ProvisioningContext) => {
      const desired = desiredOf(context, claimed);
      const transport = await connect(context);
      try {
        const changes: PlannedChange[] = [];
        const created = new Set<string>();
        for (const [exchange, resource] of desired.exchanges) {
          const state = await transport.checkExchange(exchange, exchangeType);
          if (state === "missing")
            created.add(exchange);
          changes.push(planned({ type: "rabbitmq.exchange", target: exchange, resource, action: state === "missing" ? "create" : state === "matches" ? "none" : "replace", reason: state === "missing" ? "The notification exchange does not exist." : state === "matches" ? "The exchange exists as needed." : `The exchange exists with another type than ${exchangeType}; RabbitMQ cannot change it in place.`, details: { exchangeType } }));
        }
        for (const declaration of desired.queues) {
          const state = await transport.checkQueue(declaration.queue, declaration.arguments);
          if (state === "missing")
            created.add(declaration.queue);
          changes.push(planned({ type: "rabbitmq.queue", target: declaration.queue, resource: declaration.resource, action: state === "missing" ? "create" : state === "matches" ? "none" : "replace", reason: state === "missing" ? `The ${declaration.purpose} queue does not exist.` : state === "matches" ? `The ${declaration.purpose} queue exists as needed.` : `The ${declaration.purpose} queue exists with other arguments; RabbitMQ cannot change them in place, and replacing it deletes its messages.`, details: { purpose: declaration.purpose, arguments: { ...declaration.arguments } } }));
        }
        for (const binding of desired.bindings) {
          const fresh = created.has(binding.queue) || created.has(binding.exchange);
          changes.push(planned({ type: "rabbitmq.binding", target: `${binding.exchange} -> ${binding.queue}`, resource: binding.resource, action: fresh ? "create" : "update", reason: fresh ? "The subscription queue is bound to the notification exchange." : "Bindings cannot be read over AMQP 0-9-1; the binding is declared again, which changes nothing when it exists.", details: { exchange: binding.exchange, queue: binding.queue, routingKey } }));
        }
        const diagnostics: Diagnostic[] = [];
        const outputs: JsonObject = { queues: desired.queues.map(queue => queue.queue), exchanges: [...desired.exchanges.keys()] };
        return { changes, diagnostics, outputs };
      } finally {
        await transport.close();
      }
    },
    apply: async (context: ProvisioningContext, changes: readonly PlannedChange[]) => {
      const transport = await connect(context);
      const applied: AppliedChange[] = [];
      try {
        for (const change of changes) {
          const details = (change.details ?? {}) as { readonly arguments?: Readonly<Record<string, string | number>>; readonly exchangeType?: AmqpExchangeType; readonly exchange?: string; readonly queue?: string; readonly routingKey?: string };
          try {
            if (change.type === "rabbitmq.exchange") {
              if (change.action === "replace")
                await transport.removeExchange(change.target);
              await transport.declareExchange(change.target, details.exchangeType ?? exchangeType);
            } else if (change.type === "rabbitmq.queue") {
              if (change.action === "replace")
                await transport.remove(change.target);
              await transport.declare(change.target, details.arguments ?? {});
            } else if (change.type === "rabbitmq.binding") {
              await transport.bindQueue(details.queue!, details.exchange!, details.routingKey ?? routingKey);
            } else {
              applied.push({ change, status: "skipped", message: "Not a change this provisioner makes." });
              continue;
            }
            applied.push({ change, status: "applied" });
          } catch (error) {
            applied.push({ change, status: "failed", message: error instanceof Error ? error.message : String(error) });
            break;
          }
        }
        return applied;
      } finally {
        await transport.close();
      }
    }
  });
}