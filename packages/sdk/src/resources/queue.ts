import type {
  HandlerInvoke,
  InferInput,
  InferOutput,
  InvocationLogger,
  QueueMessageTriggerOptions,
  ResourceDescriptorOf,
  StandardSchemaV1
} from "@holqa/core";

import type {
  HandlerRegistration,
  ResourceHandle
} from "@/resources/handle";
import type { CheckResourceId } from "@/types/checks";

import {
  descriptorKey,
  descriptorProtocol,
  prepareWirePayload,
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
import { ownerOf } from "@/internal/ownership";

/** Redelivery behaviour a queue requires from its binding. */
export interface QueueDeliveryOptions {
  /** Total delivery attempts before a message is dead-lettered or dropped. */
  readonly maxAttempts?: number;
  /** Requires messages that exhaust `maxAttempts` to be kept in a dead-letter destination. */
  readonly deadLetter?: boolean;
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
    readonly messageId: string;
  };
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
}

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
   * Converts a message to its JSON wire form, validates that form and hands it
   * to the bound runtime. Consumers decode it again with the same schema.
   * Rejects values without a JSON form (`HOLQA_PAYLOAD_NOT_SERIALIZABLE`) and
   * invalid messages (`HOLQA_INPUT_INVALID`). The driver receives the bare
   * payload; drivers do not use the versioned message envelope yet.
   */
  readonly send: (message: InferInput<Message>) => Promise<void>;
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
      ...definedEntries({ maxAttempts: options.delivery?.maxAttempts })
    }),
    schemas: Object.freeze({ message: options.message })
  });
  const subject = `message for queue "${id}"`;

  const handle: QueueHandle<Id, Message> = Object.freeze({
    [descriptorKey]: descriptor,
    kind: "queue" as const,
    id: options.id,
    message: options.message,
    send: async (message: InferInput<Message>) => {
      const operation = `queue "${id}" send`;
      const driver = resolveDriver(ownerOf(handle, operation), descriptor, operation);
      // Put the *input* form on the wire, as a JSON copy validated with the
      // same schema consumers decode it with. Forwarding the decoded output
      // would make transformed fields (for example a Date) fail consumer
      // validation, and forwarding the caller's object would let later
      // mutation change what was sent.
      const payload = await prepareWirePayload(options.message, message, subject);
      await driver.send(payload);
    },
    consume: <const HandlerId extends string>(consumer: QueueConsumerOptions<HandlerId, InferOutput<Message>> & CheckResourceId<HandlerId>) => {
      const rawConsumer = requireOptions(consumer, `consumer of queue "${id}"`);
      const consumerProblems = new DeclarationProblems(`consumer "${String(rawConsumer.id)}" of queue "${id}"`);
      const handlerIdCandidate = consumerProblems.identifier(rawConsumer.id, "consumer id");
      consumerProblems.positiveInteger(rawConsumer.concurrency, "concurrency");
      if (typeof rawConsumer.handler !== "function")
        consumerProblems.invalid("\"handler\" must be a function.");
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
        await consumer.handler({
          message: validated,
          delivery: { attempt: context.metadata.attempt, messageId: context.metadata.messageId },
          signal: context.signal,
          log: context.log
        });
        return undefined;
      };
      const registration: QueueConsumer<Id, HandlerId, Message> = Object.freeze({
        [descriptorKey]: Object.freeze({
          protocol: descriptorProtocol,
          type: "handler" as const,
          definition: freezeJson({
            id: handlerId,
            trigger: { kind: "queue.message" as const, resource: { kind: "queue" as const, id }, options: definedEntries({ concurrency: consumer.concurrency }) }
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