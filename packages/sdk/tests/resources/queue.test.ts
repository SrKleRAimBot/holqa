import type {
  HolqaError,
  QueueSendOptions,
  QueueSendReceipt
} from "@holqa/core";
import type {
  QueueConsumer,
  QueueConsumerFor,
  QueueMessageInput,
  QueueMessageOutput
} from "@/index";

import {
  bindApp,
  getAppDescriptor,
  getHandlerDescriptor,
  getResourceDescriptor,
  InputValidationError
} from "@holqa/core";
import {
  createContext,
  createTestBinding,
  thrownCodes
} from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";
import { z } from "zod";

import {
  defineApp,
  queue
} from "@/index";

/** Version 1 of a message contract. */
const orderV1 = z.object({ orderId: z.string() });

/** Version 2 of the same contract: a required field was added. */
const orderV2 = orderV1.extend({ currency: z.enum(["EUR", "USD"]) });

describe("queue", () => {
  it("normalizes its declaration into a descriptor with typed requirements", () => {
    const orders = queue({ id: "orders", message: orderV1, schemaVersion: 2, delivery: { maxAttempts: 5, deadLetter: true } });
    expect<unknown>(getResourceDescriptor(orders)).toEqual({
      protocol: 1,
      type: "resource",
      kind: "queue",
      id: "orders",
      config: { schemaVersion: 2 },
      requirements: { delivery: "at-least-once", maxAttempts: 5, deadLetter: true },
      schemas: { message: orderV1 }
    });
    const minimal = queue({ id: "minimal", message: orderV1, schemaVersion: 1 });
    expect(getResourceDescriptor(minimal)?.requirements).toEqual({ delivery: "at-least-once", deadLetter: false });
  });

  it("derives producer and consumer types from the schema, so a schema change reaches both", () => {
    const v1 = queue({ id: "orders-v1", message: orderV1, schemaVersion: 1 });
    const v2 = queue({ id: "orders-v2", message: orderV2, schemaVersion: 2 });
    expectTypeOf<QueueMessageInput<typeof v1>>().toEqualTypeOf<{ orderId: string }>();
    expectTypeOf<QueueMessageInput<typeof v2>>().toEqualTypeOf<{ orderId: string; currency: "EUR" | "USD" }>();
    expectTypeOf<QueueMessageOutput<typeof v2>>().toEqualTypeOf<{ orderId: string; currency: "EUR" | "USD" }>();
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = async (): Promise<void> => {
      await v1.send({ orderId: "o-1" });
      // @ts-expect-error -- the v1 message is missing the field version 2 requires.
      await v2.send({ orderId: "o-1" });
      v2.consume({
        id: "orders.v2",
        handler: ({ message }) => {
          expectTypeOf(message.currency).toEqualTypeOf<"EUR" | "USD">();
        }
      });
      v1.consume({
        id: "orders.v1",
        handler: ({ message }) => {
          // @ts-expect-error -- version 1 messages have no currency.
          void message.currency;
        }
      });
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("accepts any Standard Schema, including a hand-written one", () => {
    const counter = queue({
      id: "counter",
      schemaVersion: 1,
      message: {
        "~standard": {
          version: 1,
          vendor: "hand-written",
          validate: (value: unknown) => typeof value === "number" ? { value } : { issues: [{ message: "Expected a number." }] },
          types: undefined as unknown as { readonly input: number; readonly output: number }
        }
      }
    });
    expectTypeOf<QueueMessageInput<typeof counter>>().toEqualTypeOf<number>();
    expect(counter.id).toBe("counter");
  });

  it("rejects malformed declarations at compile time", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- `message` is required.
      queue({ id: "no-message", schemaVersion: 1 });
      // @ts-expect-error -- `schemaVersion` is required.
      queue({ id: "no-version", message: orderV1 });
      // @ts-expect-error -- a parse function alone is not a Standard Schema.
      queue({ id: "bad-schema", schemaVersion: 1, message: { parse: (value: unknown) => value } });
      // @ts-expect-error -- uppercase identifiers violate the identifier grammar.
      queue({ id: "Orders", message: orderV1, schemaVersion: 1 });
      // @ts-expect-error -- `delivery.maxAttempts` must be a number.
      queue({ id: "attempts", message: orderV1, schemaVersion: 1, delivery: { maxAttempts: "5" } });
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("reports every malformed option at run time", () => {
    expect(thrownCodes(() => queue({ id: "Bad_Id", message: { parse: String }, schemaVersion: 0, delivery: { maxAttempts: 1.5, deadLetter: "yes" } } as never))).toEqual([
      "HOLQA_RESOURCE_ID_INVALID",
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_DECLARATION_INVALID"
    ]);
    expect(thrownCodes(() => queue({ id: "x", message: orderV1 } as never))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });

  it("validates messages before sending and puts the input form on the wire", async () => {
    const event = z.object({ at: z.iso.datetime().transform(value => new Date(value)) });
    const events = queue({ id: "events", message: event, schemaVersion: 1 });
    const app = defineApp({ name: "wire", resources: { events } });
    const binding = createTestBinding();
    const unbind = bindApp(getAppDescriptor(app)!, binding);
    try {
      await events.send({ at: "2026-10-17T00:00:00.000Z" });
      expect(binding.sent.map(({ queue, message }) => ({ queue, message }))).toEqual([{ queue: "events", message: { at: "2026-10-17T00:00:00.000Z" } }]);
      const error = await events.send({ at: "yesterday" }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InputValidationError);
      expect((error as InputValidationError).issues.map(issue => issue.path)).toEqual(["at"]);
      expect(binding.sent).toHaveLength(1);
    } finally {
      unbind();
    }
  });

  it("sends a JSON copy, so later mutation of the caller's object cannot change what was sent", async () => {
    const notes = queue({ id: "notes", message: z.object({ text: z.string(), tag: z.string().optional() }), schemaVersion: 1 });
    const app = defineApp({ name: "copies", resources: { notes } });
    const binding = createTestBinding();
    const unbind = bindApp(getAppDescriptor(app)!, binding);
    try {
      const message = { text: "hello", tag: undefined };
      await notes.send(message);
      message.text = "changed";
      expect(binding.sent.map(({ queue, message }) => ({ queue, message }))).toEqual([{ queue: "notes", message: { text: "hello" } }]);
    } finally {
      unbind();
    }
  });

  it("rejects values without a JSON form before they reach the runtime", async () => {
    const loose = queue({ id: "loose", message: z.object({ at: z.unknown() }), schemaVersion: 1 });
    const app = defineApp({ name: "loose", resources: { loose } });
    const binding = createTestBinding();
    const unbind = bindApp(getAppDescriptor(app)!, binding);
    try {
      const error: unknown = await loose.send({ at: new Date(0) }).catch((caught: unknown) => caught);
      expect((error as HolqaError).code).toBe("HOLQA_PAYLOAD_NOT_SERIALIZABLE");
      expect(binding.sent).toEqual([]);
    } finally {
      unbind();
    }
  });

  it("validates the same message on send and on receipt, with input and output types", async () => {
    const event = z.object({ at: z.codec(z.iso.datetime(), z.date(), { decode: text => new Date(text), encode: date => date.toISOString() }) });
    const events = queue({ id: "dated-events", message: event, schemaVersion: 1 });
    const received: Date[] = [];
    const consumer = events.consume({ id: "dated-events.read", handler: ({ message }) => {
      expectTypeOf(message.at).toEqualTypeOf<Date>();
      received.push(message.at);
    } });
    expectTypeOf<Parameters<typeof events.send>[0]>().toEqualTypeOf<{ at: string }>();
    /**
     * Never called: only its type-checking matters.
     *
     * @returns The pending call, which would reject at run time.
     */
    const sendDecoded = () => events.send(
      // @ts-expect-error `send` takes the wire (input) form, not the decoded Date.
      { at: new Date(0) }
    );
    expect(typeof sendDecoded).toBe("function");
    const app = defineApp({ name: "round-trip", resources: { events } });
    const binding = createTestBinding();
    const unbind = bindApp(getAppDescriptor(app)!, binding);
    try {
      await events.send({ at: "2026-10-18T09:00:00.000Z" });
      await consumer["~holqa"].invoke(binding.sent[0]!.message, createContext({ attempt: 1, messageId: "m-1" }));
      expect(received.map(date => date.toISOString())).toEqual(["2026-10-18T09:00:00.000Z"]);
    } finally {
      unbind();
    }
  });
});

describe("queue consumers", () => {
  const jobs = queue({ id: "jobs", message: z.object({ n: z.number() }), schemaVersion: 1 });

  it("separates declarative metadata from the executable handler", () => {
    let calls = 0;
    const consumer = jobs.consume({ id: "jobs.run", concurrency: 2, handler: () => {
      calls += 1;
    } });
    expectTypeOf(consumer).toEqualTypeOf<QueueConsumer<"jobs", "jobs.run", typeof jobs.message>>();
    const descriptor = getHandlerDescriptor(consumer)!;
    expect<unknown>(descriptor.definition).toEqual({ id: "jobs.run", trigger: { kind: "queue.message", resource: { kind: "queue", id: "jobs" }, options: { concurrency: 2 } } });
    expect(Object.isFrozen(descriptor.definition.trigger.options)).toBe(true);
    expect(calls).toBe(0);
  });

  it("validates untrusted input before running user code", async () => {
    const received: number[] = [];
    const consumer = jobs.consume({ id: "jobs.collect", handler: ({ message, delivery }) => {
      received.push(message.n * 10 + delivery.attempt);
    } });
    await consumer["~holqa"].invoke({ n: 4 }, createContext({ attempt: 1, messageId: "m-1" }));
    expect(received).toEqual([41]);
    expect(await consumer["~holqa"].invoke({ n: "4" }, createContext({ attempt: 1, messageId: "m-2" })).catch((error: unknown) => (error as InputValidationError).code)).toBe("HOLQA_INPUT_INVALID");
    expect(received).toEqual([41]);
  });

  it("types consumers written apart from their registration", () => {
    /**
     * Checks the message type of a consumer declared before its registration.
     *
     * @param context - The delivery context.
     * @param context.message - The validated message.
     */
    const handler: QueueConsumerFor<typeof jobs> = ({ message }) => {
      expectTypeOf(message).toEqualTypeOf<{ n: number }>();
    };
    expect(getHandlerDescriptor(jobs.consume({ id: "jobs.apart", handler }))?.definition.id).toBe("jobs.apart" as never);
  });

  it("rejects malformed registrations", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- `handler` is required.
      jobs.consume({ id: "jobs.none" });
      // @ts-expect-error -- handler identifiers follow the identifier grammar.
      jobs.consume({ id: "Jobs Run", handler: () => {} });
      // @ts-expect-error -- the message has no `m` property.
      jobs.consume({ id: "jobs.wrong", handler: ({ message }) => void message.m });
    };
    expect(typeof neverCalled).toBe("function");
    expect(thrownCodes(() => jobs.consume({ id: "jobs..run", concurrency: 0, handler: "nope" } as never))).toEqual([
      "HOLQA_RESOURCE_ID_INVALID",
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_DECLARATION_INVALID"
    ]);
  });

  it("sends versioned envelopes, returns the queue's receipt and forwards delays", async () => {
    const jobs = queue({ id: "jobs", message: orderV1, schemaVersion: 3 });
    const app = defineApp({ name: "envelopes", resources: { jobs } });
    const binding = createTestBinding();
    const unbind = bindApp(getAppDescriptor(app)!, binding);
    try {
      expect(await jobs.send({ orderId: "o-1" })).toEqual({ messageId: "m-1" });
      expect(await jobs.send({ orderId: "o-2" }, { delaySeconds: 30 })).toEqual({ messageId: "m-2" });
      expect(binding.sent.map(({ envelope, options }) => ({ envelope, options }))).toEqual([
        { envelope: { format: "holqa.message/1", schemaVersion: 3, payload: { orderId: "o-1" } }, options: {} },
        { envelope: { format: "holqa.message/1", schemaVersion: 3, payload: { orderId: "o-2" } }, options: { delaySeconds: 30 } }
      ]);
    } finally {
      unbind();
    }
  });

  it("rejects malformed delays and delays the binding cannot honour, without sending", async () => {
    const jobs = queue({ id: "jobs", message: orderV1, schemaVersion: 1 });
    const app = defineApp({ name: "delays", resources: { jobs } });
    const binding = createTestBinding({}, { queue: { delivery: ["at-least-once"], maxAttempts: 5, deadLetter: false, maxDelaySeconds: 60 } });
    const unbind = bindApp(getAppDescriptor(app)!, binding);
    /**
     * Sends with options that must be rejected and returns the error code.
     *
     * @param options - The send options under test.
     * @returns The code of the thrown error.
     */
    const rejected = async (options: unknown): Promise<string> => jobs.send({ orderId: "o" }, options as never).then(() => "sent", (error: HolqaError) => error.code);
    try {
      expect(await rejected({ delaySeconds: -1 })).toBe("HOLQA_OPERATION_INVALID");
      expect(await rejected({ delaySeconds: 1.5 })).toBe("HOLQA_OPERATION_INVALID");
      expect(await rejected("soon")).toBe("HOLQA_OPERATION_INVALID");
      expect(await rejected({ delaySeconds: 61 })).toBe("HOLQA_BINDING_CAPABILITY_UNSUPPORTED");
      expect(binding.sent).toEqual([]);
      expect(await rejected({ delaySeconds: 60 })).toBe("sent");
    } finally {
      unbind();
    }
  });

  it("declares a backoff as a requirement and rejects malformed ones", () => {
    const retried = queue({ id: "retried", message: orderV1, schemaVersion: 1, delivery: { maxAttempts: 4, backoff: { strategy: "exponential", initialDelaySeconds: 2, maxDelaySeconds: 60 } } });
    expect<unknown>(getResourceDescriptor(retried)?.requirements).toEqual({
      delivery: "at-least-once",
      deadLetter: false,
      maxAttempts: 4,
      backoff: { strategy: "exponential", initialDelaySeconds: 2, maxDelaySeconds: 60 }
    });
    expect<unknown>(getResourceDescriptor(queue({ id: "fixed", message: orderV1, schemaVersion: 1, delivery: { backoff: { strategy: "fixed", delaySeconds: 5 } } }))?.requirements).toMatchObject({ backoff: { strategy: "fixed", delaySeconds: 5 } });
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- "linear" is not a backoff strategy.
      queue({ id: "bad", message: orderV1, schemaVersion: 1, delivery: { backoff: { strategy: "linear", delaySeconds: 1 } } });
      // @ts-expect-error -- exponential backoff needs a maximum delay.
      queue({ id: "bad", message: orderV1, schemaVersion: 1, delivery: { backoff: { strategy: "exponential", initialDelaySeconds: 1 } } });
    };
    expect(typeof neverCalled).toBe("function");
    for (const backoff of [
      { strategy: "linear" },
      { strategy: "fixed", delaySeconds: -1 },
      { strategy: "exponential", initialDelaySeconds: 10, maxDelaySeconds: 5 },
      { strategy: "exponential", initialDelaySeconds: 1, maxDelaySeconds: 5, multiplier: 0.5 }
    ])
      expect(thrownCodes(() => queue({ id: "bad", message: orderV1, schemaVersion: 1, delivery: { backoff } } as never))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });

  it("passes the producer's schema version to consumers", async () => {
    const jobs = queue({ id: "jobs", message: orderV1, schemaVersion: 2 });
    const seen: unknown[] = [];
    const consumer = jobs.consume({ id: "jobs.run", handler: ({ delivery }) => {
      seen.push(delivery);
    } });
    await consumer["~holqa"].invoke({ orderId: "o" }, createContext({ attempt: 1, messageId: "m-1", schemaVersion: 2 }));
    await consumer["~holqa"].invoke({ orderId: "o" }, createContext({ attempt: 2, messageId: "m-1" }));
    expect(seen).toEqual([{ attempt: 1, messageId: "m-1", schemaVersion: 2 }, { attempt: 2, messageId: "m-1" }]);
  });

  it("types sends with their options and receipt", () => {
    const jobs = queue({ id: "jobs", message: orderV1, schemaVersion: 1 });
    expectTypeOf(jobs.send).returns.toEqualTypeOf<Promise<QueueSendReceipt>>();
    expectTypeOf<Parameters<typeof jobs.send>[1]>().toEqualTypeOf<QueueSendOptions | undefined>();
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- delays are given in seconds.
      void jobs.send({ orderId: "o" }, { delayMs: 10 });
    };
    expect(typeof neverCalled).toBe("function");
  });
});