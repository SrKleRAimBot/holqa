import type {
  AsyncMessage,
  Consumer,
  Publisher
} from "rabbitmq-client";

import {
  bindingFailure,
  HolqaError
} from "@holqa/core";
import {
  Connection,
  ConsumerStatus
} from "rabbitmq-client";

/** One message received from the broker. */
export interface AmqpMessage {
  readonly body: Uint8Array;
  readonly messageId: string | undefined;
  readonly headers: Readonly<Record<string, unknown>>;
  /** Whether the broker delivered the message before (after a lost connection or a requeue). */
  readonly redelivered: boolean;
}

/** How a received message is settled with the broker: acknowledged (removed) or requeued. */
export type AmqpSettlement = "ack" | "requeue";

/** Properties of a published message. */
export interface AmqpPublishProperties {
  readonly messageId: string;
  readonly headers: Readonly<Record<string, string | number>>;
}

/** Arguments of a queue declaration, as provisioning passes them. */
export type AmqpQueueArguments = Readonly<Record<string, string | number>>;

/** A running consumer. */
export interface AmqpConsumer {
  /** Stops consuming; unsettled messages return to the queue. */
  readonly close: () => Promise<void>;
}

/**
 * What the queue provider needs from an AMQP 0-9-1 client. The production
 * transport uses `rabbitmq-client`; tests use an in-memory broker with the
 * same semantics.
 */
export interface AmqpTransport {
  /**
   * Waits until connected.
   *
   * @throws {HolqaError} A classified binding failure: `credentials-invalid`, `unavailable` or `failed`.
   */
  readonly connect: (timeoutMs: number) => Promise<void>;
  /** Publishes to a queue through the default exchange and resolves once the broker confirmed it. */
  readonly publish: (queue: string, body: Uint8Array, properties: AmqpPublishProperties) => Promise<void>;
  /**
   * Consumes a queue with at most `prefetch` unsettled messages. The handler's
   * promise settles each message; `generation` identifies the connection it
   * arrived on, so settlements after a reconnect can be told apart.
   */
  readonly consume: (queue: string, prefetch: number, handler: (message: AmqpMessage, generation: number) => Promise<AmqpSettlement>) => Promise<AmqpConsumer>;
  /** Reports a queue's ready messages, or `undefined` when the queue does not exist. Never creates it. */
  readonly inspect: (queue: string) => Promise<{ readonly messageCount: number } | undefined>;
  /** Creates a durable queue with arguments when missing. For provisioning only. */
  readonly declare: (queue: string, args: AmqpQueueArguments) => Promise<void>;
  /** Deletes a queue. For provisioning only, after explicit authorization. */
  readonly remove: (queue: string) => Promise<void>;
  /** Increments whenever the connection is (re)established. */
  readonly generation: () => number;
  readonly connected: () => boolean;
  readonly close: () => Promise<void>;
}

/** Settings of {@link rabbitMqTransport}. */
export interface RabbitMqTransportOptions {
  /** The provider's name, for classified failures. */
  readonly binding: string;
  /** How long to wait between reconnection attempts at most, in milliseconds. Default 5 000. */
  readonly retryHighMs?: number;
}

/**
 * Converts a `rabbitmq-client` error into a classified binding failure,
 * without its message when that could echo the connection URL.
 *
 * @param binding - The provider's name.
 * @param error - The client's error.
 * @param action - What was attempted, for the message.
 * @returns The error to throw.
 */
export function classifyAmqpError(binding: string, error: unknown, action: string): HolqaError {
  const code = typeof error === "object" && error !== null ? String((error as { readonly code?: unknown }).code ?? "") : "";
  if (code === "ACCESS_REFUSED" || code === "NOT_ALLOWED")
    return new HolqaError(bindingFailure("credentials-invalid", { binding, message: `The broker rejected the credentials while ${action}.`, details: { reason: code } }));
  if (code === "NOT_FOUND")
    return new HolqaError(bindingFailure("failed", { binding, message: `A queue needed while ${action} does not exist.`, hint: "Create the queue topology before starting, with your own tooling or a provisioning step.", details: { reason: code } }));
  if (code === "PRECONDITION_FAILED")
    return new HolqaError(bindingFailure("failed", { binding, message: `A queue exists with other settings than needed while ${action}.`, details: { reason: code } }));
  return new HolqaError(bindingFailure("unavailable", { binding, message: `The broker could not be reached while ${action}.`, details: { reason: code === "" ? "connection" : code } }));
}

/**
 * Creates the production transport: a `rabbitmq-client` connection that
 * reconnects with backoff, a confirming publisher, and consumers that are
 * re-created after every reconnect. The URL is used only to connect and is
 * never included in errors.
 *
 * @param url - The AMQP URL, including credentials.
 * @param options - The binding's name and reconnection limit.
 * @returns A transport that reconnects on its own.
 */
export function rabbitMqTransport(url: string, options: RabbitMqTransportOptions): AmqpTransport {
  const connection = new Connection({ url, retryHigh: options.retryHighMs ?? 5_000, connectionName: `holqa ${options.binding}` });
  let generation = 0;
  connection.on("connection", () => {
    generation += 1;
  });
  // Errors are reported through operations and health; without a listener the client would throw them.
  // The last one explains a connection that never succeeds, for example a rejected login.
  let lastError: unknown;
  connection.on("error", (error: unknown) => {
    lastError = error;
  });
  let publisher: Publisher | undefined;
  const consumers = new Set<Consumer>();
  return Object.freeze({
    connect: async (timeoutMs: number) => {
      try {
        await connection.onConnect(timeoutMs, true);
      } catch (error) {
        throw classifyAmqpError(options.binding, lastError ?? error, "connecting");
      }
    },
    publish: async (queue: string, body: Uint8Array, properties: AmqpPublishProperties) => {
      publisher ??= connection.createPublisher({ confirm: true, maxAttempts: 1 });
      try {
        await publisher.send({ routingKey: queue, exchange: "", durable: true, messageId: properties.messageId, headers: { ...properties.headers }, contentType: "application/json", contentEncoding: "utf-8" }, Buffer.from(body));
      } catch (error) {
        throw classifyAmqpError(options.binding, error, `publishing to "${queue}"`);
      }
    },
    consume: async (queue: string, prefetch: number, handler: (message: AmqpMessage, generation: number) => Promise<AmqpSettlement>) => {
      const consumer = connection.createConsumer({ queue, queueOptions: { queue, passive: true }, qos: { prefetchCount: prefetch }, concurrency: prefetch, requeue: true }, async (message: AsyncMessage) => {
        const settlement = await handler({
          body: Buffer.isBuffer(message.body) ? new Uint8Array(message.body) : new TextEncoder().encode(typeof message.body === "string" ? message.body : JSON.stringify(message.body)),
          messageId: message.messageId,
          headers: (message.headers ?? {}) as Readonly<Record<string, unknown>>,
          redelivered: message.redelivered
        }, generation);
        return settlement === "ack" ? ConsumerStatus.ACK : ConsumerStatus.REQUEUE;
      });
      consumer.on("error", () => {});
      consumers.add(consumer);
      return Object.freeze({
        close: async () => {
          consumers.delete(consumer);
          await consumer.close();
        }
      });
    },
    inspect: async (queue: string) => {
      try {
        const declared = await connection.queueDeclare({ queue, passive: true });
        return { messageCount: declared.messageCount };
      } catch (error) {
        if (typeof error === "object" && error !== null && (error as { readonly code?: unknown }).code === "NOT_FOUND")
          return undefined;
        throw classifyAmqpError(options.binding, error, `inspecting "${queue}"`);
      }
    },
    declare: async (queue: string, args: AmqpQueueArguments) => {
      try {
        await connection.queueDeclare({ queue, durable: true, arguments: { ...args } });
      } catch (error) {
        throw classifyAmqpError(options.binding, error, `declaring "${queue}"`);
      }
    },
    remove: async (queue: string) => {
      try {
        await connection.queueDelete({ queue });
      } catch (error) {
        throw classifyAmqpError(options.binding, error, `deleting "${queue}"`);
      }
    },
    generation: () => generation,
    connected: () => connection.ready,
    close: async () => {
      await Promise.all([...consumers].map(consumer => consumer.close()));
      await publisher?.close();
      await connection.close();
    }
  });
}