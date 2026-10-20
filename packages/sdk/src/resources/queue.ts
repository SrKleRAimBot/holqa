import type {
  HandlerInvoke,
  InferInput,
  InferOutput,
  InvocationLineage,
  InvocationLogger,
  QueueBackoff,
  QueueMessageTriggerOptions,
  QueueSendOptions,
  QueueSendReceipt,
  ResourceDescriptorOf,
  StandardSchemaV1
} from "@holqa/core";

import type {
  HandlerEventOptions,
  IdempotencyOptions
} from "@/internal/event-options";
import type {
  HandlerRegistration,
  ResourceHandle
} from "@/resources/handle";
import type { CheckResourceId } from "@/types/checks";

import {
  descriptorKey,
  descriptorProtocol,
  diagnosticCodes,
  failWith,
  messageEnvelopeFormat,
  prepareWirePayload,
  requireBinding,
  resolveDriver,
  validateInput
} from "@holqa/core";

import {
  DeclarationProblems,
  definedEntries,
  freezeJson,
  optionalObject,
  requireOptions
} from "@/internal/declaration";
import {
  readEventOptions,
  readIdempotencyOptions,
  runIdempotently
} from "@/internal/event-options";
import { ownerOf } from "@/internal/ownership";

/** Redelivery behaviour a queue requires from its binding. */
export interface QueueDeliveryOptions {
  /** Total delivery attempts before a message is dead-lettered or dropped. */
  readonly maxAttempts?: number;
  /** Requires messages that exhaust `maxAttempts` to be kept in a dead-letter destination. */
  readonly deadLetter?: boolean;
  /** The delay before each redelivery. Absent means the runtime's default (1 s, doubling, at most 5 minutes). */
  readonly backoff?: QueueBackoff;
}

/**
 * Options accepted by {@link queue}.
 *
 * @typeParam Id - The literal identifier.
 * @typeParam Message - The message schema.
 */
export interface QueueOptions<Id extends string, Message extends StandardSchemaV1> {
  /** The persistent identity of the queue. */
  readonly id: Id;
  /** The message contract. Any Standard Schema v1 implementation. */
  readonly message: Message;
  /** Version of the message contract. Increment it when the schema changes incompatibly. */
  readonly schemaVersion: number;
  readonly delivery?: QueueDeliveryOptions;
}

/**
 * What a queue consumer receives for one delivery.
 *
 * @typeParam Message - The validated message type (the schema's output type).
 */
export interface QueueMessageContext<Message> {
  /** The validated, possibly transformed message. */
  readonly message: Message;
  readonly delivery: {
    /** 1 for the first delivery; higher values mean redelivery. */
    readonly attempt: number;
    /** The same for every delivery of one sent message, including duplicates: use it to make processing idempotent. */
    readonly messageId: string;
    /** The `schemaVersion` the producer sent the message with, when the runtime knows it. */
    readonly schemaVersion?: number;
  };
  /**
   * The delivery's event lineage (root operation, cause and depth), when the
   * runtime tracks it. Retries keep it; messages this consumer sends are one
   * hop deeper. Useful for termination conditions in intentional cycles.
   */
  readonly lineage?: InvocationLineage;
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
}

/**
 * What an idempotency key function of a queue consumer receives.
 *
 * @typeParam Message - The validated message type.
 */
export type QueueIdempotencyContext<Message> = Pick<QueueMessageContext<Message>, "message" | "delivery">;

/**
 * A queue consumer function. Throwing requests redelivery; delivery is at
 * least once, so consumers must be idempotent.
 *
 * @typeParam Message - The validated message type.
 */
export type QueueConsumerFunction<Message> = (context: QueueMessageContext<Message>) => Promise<void> | void;

/**
 * Options accepted by {@link QueueHandle.consume}.
 *
 * @typeParam HandlerId - The handler's literal identifier.
 * @typeParam Message - The validated message type.
 */
export interface QueueConsumerOptions<HandlerId extends string, Message> extends QueueMessageTriggerOptions {
  /** The handler's persistent identity. */
  readonly id: HandlerId;
  readonly handler: QueueConsumerFunction<Message>;
  /** Event safety declarations: publications analysis cannot see, an intentional cycle, limits. */
  readonly events?: HandlerEventOptions;
  /**
   * Skips deliveries whose idempotency key (default: the message identifier)
   * already completed. Requires a binding with an idempotency store; see
   * {@link IdempotencyOptions} for what it does and does not guarantee.
   */
  readonly idempotency?: boolean | IdempotencyOptions<QueueIdempotencyContext<Message>>;
}

/**
 * A registered queue consumer. Export it from a handler module.
 *
 * @typeParam QueueId - The queue's identifier.
 * @typeParam HandlerId - The handler's identifier.
 * @typeParam Message - The queue's message schema.
 */
export interface QueueConsumer<QueueId extends string, HandlerId extends string, Message extends StandardSchemaV1> extends HandlerRegistration<"queue.message", HandlerId, QueueId> {
  /** Phantom type carrier for the message schema; never present at run time. */
  readonly "~message"?: Message;
}

/**
 * A typed handle to a declared queue. `send` accepts the schema's input type;
 * consumers receive its output type.
 *
 * @typeParam Id - The literal identifier.
 * @typeParam Message - The message schema.
 */
export interface QueueHandle<Id extends string, Message extends StandardSchemaV1> extends ResourceHandle<"queue", Id> {
  readonly message: Message;
  /**
   * Converts a message to its JSON wire form, validates that form, wraps it in
   * a `holqa.message/1` envelope with the queue's `schemaVersion` and hands it
   * to the bound runtime. Consumers decode it again with the same schema.
   * Resolves once the queue has accepted the message, with the identifier it
   * assigned.
   *
   * Sending is not atomic with any other write: a database update and a send
   * can each succeed or fail on its own. See the outbox guidance in the
   * runtime reference.
   *
   * @throws {HolqaError} `HOLQA_PAYLOAD_NOT_SERIALIZABLE` for values without a JSON form, `HOLQA_INPUT_INVALID` for invalid messages,
   * `HOLQA_OPERATION_INVALID` for a malformed delay, and `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` when the binding cannot delay messages that long.
   */
  readonly send: (message: InferInput<Message>, options?: QueueSendOptions) => Promise<QueueSendReceipt>;
  /** Registers a consumer for this queue. Registration is declarative: nothing runs until a runtime invokes it. */
  readonly consume: <const HandlerId extends string>(options: QueueConsumerOptions<HandlerId, InferOutput<Message>> & CheckResourceId<HandlerId>) => QueueConsumer<Id, HandlerId, Message>;
}

/** The type producers pass to `send` for a queue handle: the schema's input type. */
export type QueueMessageInput<Handle> = Handle extends QueueHandle<string, infer Message> ? InferInput<Message> : never;

/** The type consumers receive from a queue handle: the schema's output type. */
export type QueueMessageOutput<Handle> = Handle extends QueueHandle<string, infer Message> ? InferOutput<Message> : never;

/** A consumer function typed from a queue handle, for consumers written apart from their registration. */
export type QueueConsumerFor<Handle> = QueueConsumerFunction<QueueMessageOutput<Handle>>;

/**
 * Declares a durable queue: its identity, message contract and the delivery
 * behaviour it requires. Pure: performs no I/O and creates no infrastructure.
 *
 * @param options - Identifier, message schema, schema version and delivery requirements.
 * @returns A typed queue handle.
 * @throws {HolqaError} `HOLQA_RESOURCE_ID_INVALID` for an invalid identifier, or
 * `HOLQA_DECLARATION_INVALID` when `message` is not a Standard Schema or an option is malformed.
 */
export function queue<const Id extends string, Message extends StandardSchemaV1>(options: QueueOptions<Id, Message> & CheckResourceId<Id>): QueueHandle<Id, Message> {
  const raw = requireOptions(options, "queue");
  const problems = new DeclarationProblems(`queue "${String(raw.id)}"`);
  const idCandidate = problems.identifier(raw.id, "queue id");
  problems.schema(raw.message, "message");
  problems.positiveInteger(raw.schemaVersion, "schemaVersion");
  if (raw.schemaVersion === undefined)
    problems.invalid("\"schemaVersion\" is required.");
  const delivery = optionalObject<QueueDeliveryOptions>(raw.delivery, "delivery", problems);
  problems.positiveInteger(delivery.maxAttempts, "delivery.maxAttempts");
  if (delivery.deadLetter !== undefined && typeof delivery.deadLetter !== "boolean")
    problems.invalid("\"delivery.deadLetter\" must be a boolean.");
  const backoff = delivery.backoff === undefined ? undefined : readBackoff(delivery.backoff, problems);
  const id = problems.valid(idCandidate);

  const descriptor: ResourceDescriptorOf<"queue"> = Object.freeze({
    protocol: descriptorProtocol,
    type: "resource",
    kind: "queue",
    id,
    config: freezeJson({ schemaVersion: options.schemaVersion }),
    requirements: freezeJson({
      delivery: "at-least-once" as const,
      deadLetter: options.delivery?.deadLetter ?? false,
      ...definedEntries({ maxAttempts: options.delivery?.maxAttempts, backoff })
    }),
    schemas: Object.freeze({ message: options.message })
  });
  const subject = `message for queue "${id}"`;

  const handle: QueueHandle<Id, Message> = Object.freeze({
    [descriptorKey]: descriptor,
    kind: "queue" as const,
    id: options.id,
    message: options.message,
    send: async (message: InferInput<Message>, sendOptions?: QueueSendOptions) => {
      const operation = `queue "${id}" send`;
      const app = ownerOf(handle, operation);
      const driver = resolveDriver(app, descriptor, operation);
      const delaySeconds = readDelay(sendOptions, operation);
      if (delaySeconds > 0) {
        const binding = requireBinding(app, operation);
        const supported = binding.capabilities.queue?.maxDelaySeconds ?? 0;
        if (delaySeconds > supported)
          failWith(diagnosticCodes.bindingCapabilityUnsupported, `Binding "${binding.name}" cannot delay messages for queue "${id}" by ${delaySeconds} seconds; it supports at most ${supported}.`);
      }
      // Put the *input* form on the wire, as a JSON copy validated with the
      // same schema consumers decode it with. Forwarding the decoded output
      // would make transformed fields (for example a Date) fail consumer
      // validation, and forwarding the caller's object would let later
      // mutation change what was sent.
      const payload = await prepareWirePayload(options.message, message, subject);
      return driver.send(Object.freeze({ format: messageEnvelopeFormat, schemaVersion: options.schemaVersion, payload }), delaySeconds > 0 ? { delaySeconds } : {});
    },
    consume: <const HandlerId extends string>(consumer: QueueConsumerOptions<HandlerId, InferOutput<Message>> & CheckResourceId<HandlerId>) => {
      const rawConsumer = requireOptions(consumer, `consumer of queue "${id}"`);
      const consumerProblems = new DeclarationProblems(`consumer "${String(rawConsumer.id)}" of queue "${id}"`);
      const handlerIdCandidate = consumerProblems.identifier(rawConsumer.id, "consumer id");
      consumerProblems.positiveInteger(rawConsumer.concurrency, "concurrency");
      if (typeof rawConsumer.handler !== "function")
        consumerProblems.invalid("\"handler\" must be a function.");
      const events = readEventOptions(rawConsumer.events, consumerProblems);
      const idempotency = readIdempotencyOptions<QueueIdempotencyContext<InferOutput<Message>>>(rawConsumer.idempotency, consumerProblems);
      const handlerId = consumerProblems.valid(handlerIdCandidate);

      /**
       * Validates one delivered message and runs the consumer with it and its delivery metadata.
       *
       * @param input - The untrusted message from the runtime.
       * @param context - The invocation context with delivery metadata.
       * @returns `undefined` once the consumer has finished.
       */
      const invoke: HandlerInvoke<"queue.message"> = async (input, context) => {
        const validated = await validateInput(options.message, input, subject);
        const delivery = Object.freeze({
          attempt: context.metadata.attempt,
          messageId: context.metadata.messageId,
          ...context.metadata.schemaVersion === undefined ? {} : { schemaVersion: context.metadata.schemaVersion }
        });
        /**
         * Runs the user's consumer with the validated message.
         *
         * @returns What the consumer returns.
         */
        const run = (): Promise<void> | void => consumer.handler({
          message: validated,
          delivery,
          ...context.lineage === undefined ? {} : { lineage: context.lineage },
          signal: context.signal,
          log: context.log
        });
        if (idempotency === undefined)
          await run();
        else
          await runIdempotently({ app: ownerOf(handle, `consumer "${handlerId}"`), handlerId, policy: idempotency.policy, key: idempotency.key === undefined ? delivery.messageId : idempotency.key({ message: validated, delivery }), log: context.log }, run);
        return undefined;
      };
      const registration: QueueConsumer<Id, HandlerId, Message> = Object.freeze({
        [descriptorKey]: Object.freeze({
          protocol: descriptorProtocol,
          type: "handler" as const,
          definition: freezeJson({
            id: handlerId,
            trigger: { kind: "queue.message" as const, resource: { kind: "queue" as const, id }, options: definedEntries({ concurrency: consumer.concurrency }) },
            ...definedEntries({ events, idempotency: idempotency?.policy })
          }),
          schemas: Object.freeze({ message: options.message }),
          invoke
        }),
        trigger: "queue.message" as const,
        id: consumer.id,
        resourceId: options.id
      });
      return registration;
    }
  });
  return handle;
}

/**
 * Validates a declared backoff and returns a normalized copy.
 *
 * @param value - The untrusted `delivery.backoff` option.
 * @param problems - Where to record problems.
 * @returns The backoff, or `undefined` when it is malformed (the problem is recorded).
 */
function readBackoff(value: unknown, problems: DeclarationProblems): QueueBackoff | undefined {
  const raw = optionalObject<{ readonly strategy?: unknown; readonly delaySeconds?: unknown; readonly initialDelaySeconds?: unknown; readonly maxDelaySeconds?: unknown; readonly multiplier?: unknown }>(value, "delivery.backoff", problems);
  /**
   * Reports whether a value is a finite number of seconds that is not negative.
   *
   * @param seconds - The candidate.
   * @returns `true` for finite numbers of at least 0.
   */
  const isSeconds = (seconds: unknown): seconds is number => typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
  if (raw.strategy === "fixed") {
    if (!isSeconds(raw.delaySeconds)) {
      problems.invalid("\"delivery.backoff.delaySeconds\" must be a number of seconds of at least 0.");
      return undefined;
    }
    return { strategy: "fixed", delaySeconds: raw.delaySeconds };
  }
  if (raw.strategy === "exponential") {
    const { initialDelaySeconds, maxDelaySeconds, multiplier } = raw;
    if (!isSeconds(initialDelaySeconds) || !isSeconds(maxDelaySeconds) || maxDelaySeconds < initialDelaySeconds) {
      problems.invalid("\"delivery.backoff\" needs \"initialDelaySeconds\" and \"maxDelaySeconds\" of at least 0, with the maximum not below the initial delay.");
      return undefined;
    }
    if (multiplier !== undefined && (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 1)) {
      problems.invalid("\"delivery.backoff.multiplier\" must be a number of at least 1.");
      return undefined;
    }
    return { strategy: "exponential", initialDelaySeconds, maxDelaySeconds, ...multiplier === undefined ? {} : { multiplier } };
  }
  problems.invalid("\"delivery.backoff.strategy\" must be \"fixed\" or \"exponential\".");
  return undefined;
}

/**
 * Reads the delay of one send.
 *
 * @param options - The untrusted send options.
 * @param operation - The operation, for messages.
 * @returns The delay in whole seconds; 0 when absent.
 * @throws {HolqaError} `HOLQA_OPERATION_INVALID` when the options or the delay are malformed.
 */
function readDelay(options: QueueSendOptions | undefined, operation: string): number {
  if (options === undefined)
    return 0;
  if (typeof options !== "object" || options === null)
    failWith(diagnosticCodes.operationInvalid, `${operation} options must be an object.`);
  const { delaySeconds } = options;
  if (delaySeconds === undefined)
    return 0;
  if (typeof delaySeconds !== "number" || !Number.isSafeInteger(delaySeconds) || delaySeconds < 0)
    failWith(diagnosticCodes.operationInvalid, `${operation} needs "delaySeconds" to be a whole number of seconds of at least 0.`);
  return delaySeconds;
}