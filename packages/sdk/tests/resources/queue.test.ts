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
      expect(binding.sent).toEqual([{ queue: "events", message: { at: "2026-10-17T00:00:00.000Z" } }]);
      const error = await events.send({ at: "yesterday" }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InputValidationError);
      expect((error as InputValidationError).issues.map(issue => issue.path)).toEqual(["at"]);
      expect(binding.sent).toHaveLength(1);
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
});