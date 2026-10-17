import type {
  Described,
  HandlerDescriptor,
  InferInput,
  InferOutput,
  InvocationLogger,
  ResourceDescriptor,
  StandardSchemaV1
} from "@holqa/experiment-model";

import {
  descriptorKey,
  requireBinding,
  validateInput
} from "@holqa/experiment-model";

import {
  definedEntries,
  handlerDescriptor,
  resourceDescriptor
} from "@/internal/describe";
import { ownerOf } from "@/internal/ownership";

/** Redelivery policy a queue requires from its binding. */
export interface QueueDelivery {
  /** Total delivery attempts before a message is dead-lettered or dropped. */
  readonly maxAttempts?: number;
  /** Requires messages that exhaust `maxAttempts` to be kept in a dead-letter destination. */
  readonly deadLetter?: boolean;
}

/** Options accepted by {@link queue}. */
export interface QueueOptions<Id extends string, Message extends StandardSchemaV1> {
  readonly id: Id;
  readonly message: Message;
  /** Version of the message contract. Increment it when the schema changes incompatibly. */
  readonly schemaVersion: number;
  readonly delivery?: QueueDelivery;
}

/** What a queue consumer receives for one delivery. */
export interface QueueMessageContext<Message> {
  /** The validated (and possibly transformed) message. */
  readonly message: Message;
  readonly delivery: {
    /** 1 for the first delivery; higher values mean redelivery. */
    readonly attempt: number;
    readonly messageId: string;
  };
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
}

/** A queue consumer function for a message type. */
export type QueueConsumerFunction<Message> = (context: QueueMessageContext<Message>) => Promise<void> | void;

/** Options accepted by {@link QueueHandle.consume}. */
export interface QueueConsumerOptions<HandlerId extends string, Message> {
  readonly id: HandlerId;
  /** Maximum concurrent invocations of this consumer. */
  readonly concurrency?: number;
  readonly handler: QueueConsumerFunction<Message>;
}

/** A registered queue consumer. Export it from a handler module. */
export interface QueueConsumer<QueueId extends string, HandlerId extends string, Message extends StandardSchemaV1> extends Described<HandlerDescriptor> {
  readonly "kind": "queue.consumer";
  readonly "id": HandlerId;
  readonly "queueId": QueueId;
  /** Phantom type carrier; never present at runtime. */
  readonly "~message"?: Message;
}

/** A typed handle to a declared queue. */
export interface QueueHandle<Id extends string, Message extends StandardSchemaV1> extends Described<ResourceDescriptor> {
  readonly kind: "queue";
  readonly id: Id;
  readonly message: Message;
  /**
   * Sends a message. The argument type is the schema's input type. The message
   * is validated, then handed to the runtime in its input (encoded) form, which
   * is the wire format; the consumer decodes it with the same schema.
   *
   * @param message - The message to send.
   * @returns Resolves when the runtime has accepted the message.
   */
  send: (message: InferInput<Message>) => Promise<void>;
  /**
   * Registers this queue's consumer. The handler receives the schema's output type.
   *
   * @param options - The handler identifier, concurrency and function.
   * @returns The consumer registration.
   */
  consume: <const HandlerId extends string>(options: QueueConsumerOptions<HandlerId, InferOutput<Message>>) => QueueConsumer<Id, HandlerId, Message>;
}

/** Extracts the message input type of a queue handle. */
export type QueueMessageInput<Handle> = Handle extends QueueHandle<string, infer Message> ? InferInput<Message> : never;

/** Extracts the message output type of a queue handle. */
export type QueueMessageOutput<Handle> = Handle extends QueueHandle<string, infer Message> ? InferOutput<Message> : never;

/** A consumer function typed from a queue handle, for handlers defined apart from their registration. */
export type QueueConsumerFor<Handle> = QueueConsumerFunction<QueueMessageOutput<Handle>>;

/**
 * Declares a durable queue with a message schema and delivery requirements.
 * Pure: performs no I/O and creates no infrastructure.
 *
 * @param options - Identifier, message schema, schema version and delivery policy.
 * @returns A typed queue handle.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when `message` is not a Standard Schema.
 */
export function queue<const Id extends string, Message extends StandardSchemaV1>(options: QueueOptions<Id, Message>): QueueHandle<Id, Message> {
  const descriptor = resourceDescriptor("queue", options.id, definedEntries({
    schemaVersion: options.schemaVersion,
    maxAttempts: options.delivery?.maxAttempts,
    deadLetter: options.delivery?.deadLetter
  }), { message: options.message });

  const handle: QueueHandle<Id, Message> = {
    [descriptorKey]: descriptor,
    kind: "queue",
    id: options.id,
    message: options.message,
    send: async (message) => {
      const app = ownerOf(handle, `queue "${options.id}" send`);
      const binding = requireBinding(app, `queue "${options.id}" send`);
      // Validate early to catch producer bugs, but put the *input* representation
      // on the wire: consumers decode it with the same schema. Forwarding the
      // decoded output would make transformed fields (string -> Date) fail
      // validation on the consumer side.
      await validateInput(options.message, message, `message for queue "${options.id}"`);
      await binding.queue(options.id).send(message);
    },
    consume: (consumer) => {
      const registration = {
        [descriptorKey]: handlerDescriptor(consumer.id, { kind: "queue.message", resource: options.id }, definedEntries({ concurrency: consumer.concurrency }), { message: options.message }, async (input, context) => {
          const message = await validateInput(options.message, input, `message for queue "${options.id}"`);
          const { attempt, messageId } = context.metadata;
          await consumer.handler({
            message,
            delivery: { attempt: typeof attempt === "number" ? attempt : 1, messageId: typeof messageId === "string" ? messageId : context.invocationId },
            signal: context.signal,
            log: context.log
          });
          return undefined;
        }),
        kind: "queue.consumer" as const,
        id: consumer.id,
        queueId: options.id
      };
      return registration;
    }
  };
  return Object.freeze(handle);
}