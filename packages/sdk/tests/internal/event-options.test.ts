import type { InvocationContext } from "@holqa/core";

import type { DeletedObjectInfo } from "@/index";
import {
  bindApp,
  createMemoryIdempotencyStore,
  diagnosticsOf,
  getAppDescriptor,
  getHandlerDescriptor
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
  bucket,
  defineApp,
  http,
  queue,
  schedule
} from "@/index";

/** The message contract used throughout. */
const order = z.object({ orderId: z.string() });

/**
 * Declares an application with a queue, a bucket, a schedule and an API.
 *
 * @returns The application and its handles.
 */
function shop(): { readonly app: ReturnType<typeof defineApp>; readonly orders: ReturnType<typeof queue<"orders", typeof order>>; readonly files: ReturnType<typeof bucket<"files">>; readonly cleanup: ReturnType<typeof schedule<"cleanup">>; readonly api: ReturnType<typeof http.api<"api">> } {
  const orders = queue({ id: "orders", message: order, schemaVersion: 1 });
  const files = bucket({ id: "files", access: "private" });
  const cleanup = schedule({ id: "cleanup", cron: "0 * * * *", timezone: "UTC", overlap: "skip" });
  const api = http.api({ id: "api", basePath: "/api" });
  const app = defineApp({ name: "shop", handlers: ["src/**/*.ts"], resources: { orders, files, cleanup, api } });
  return { app, orders, files, cleanup, api };
}

/**
 * Invokes a handler registration's `invoke` directly.
 *
 * @param registration - A handler registration.
 * @param input - The untrusted input.
 * @param context - The invocation context.
 * @returns What `invoke` resolves to.
 */
async function invoke(registration: unknown, input: unknown, context: InvocationContext<object>): Promise<unknown> {
  const descriptor = getHandlerDescriptor(registration)!;
  return (descriptor.invoke as (input: unknown, context: InvocationContext<object>) => Promise<unknown>)(input, context);
}

describe("events option", () => {
  it("records publications by kind and identifier, sorted and unique, and a trimmed justification", () => {
    const { orders, files } = shop();
    const consumer = orders.consume({
      id: "orders.process",
      events: { publishes: [orders, files, orders], cycle: { justification: "  Requeues until the order is settled.  " }, maxPublications: 5, maxDepth: 3 },
      handler: () => {}
    });
    expect<unknown>(getHandlerDescriptor(consumer)?.definition.events).toEqual({
      publishes: [{ kind: "bucket", id: "files" }, { kind: "queue", id: "orders" }],
      cycle: { justification: "Requeues until the order is settled." },
      maxPublications: 5,
      maxDepth: 3
    });
    expect(Object.isFrozen(getHandlerDescriptor(consumer)?.definition.events)).toBe(true);
  });

  it("is accepted by every handler kind and omitted when absent", () => {
    const { orders, files, cleanup, api } = shop();
    const registrations = [
      files.onObjectCreated({ id: "files.created", events: { publishes: [orders] }, handler: () => {} }),
      files.onObjectDeleted({ id: "files.deleted", events: { maxPublications: 1 }, handler: () => {} }),
      cleanup.handle({ id: "cleanup.run", events: { publishes: [files] }, handler: () => {} }),
      api.route({ id: "orders.place", method: "POST", path: "/orders", body: order, responses: { 202: z.object({}) }, events: { publishes: [orders] }, handler: ({ reply }) => reply(202, {}) }),
      api.procedure({ id: "orders.count", operation: "query", output: z.number(), events: { maxPublications: 2 }, handler: () => 1 })
    ];
    expect<unknown>(registrations.map(registration => getHandlerDescriptor(registration)?.definition.events)).toEqual([
      { publishes: [{ kind: "queue", id: "orders" }] },
      { maxPublications: 1 },
      { publishes: [{ kind: "bucket", id: "files" }] },
      { publishes: [{ kind: "queue", id: "orders" }] },
      { maxPublications: 2 }
    ]);
    expect(getHandlerDescriptor(orders.consume({ id: "plain", handler: () => {} }))?.definition).not.toHaveProperty("events");
  });

  it("rejects malformed settings with every problem at once", () => {
    const { orders } = shop();
    /** Registers a consumer with four malformed event settings. */
    const problems = (): void => {
      orders.consume({ id: "orders.process", events: { publishes: ["orders" as never], cycle: { justification: "" }, maxDepth: 0, unknown: 1 } as never, handler: () => {} });
    };
    expect(thrownCodes(problems)).toEqual(["HOLQA_DECLARATION_INVALID", "HOLQA_DECLARATION_INVALID", "HOLQA_DECLARATION_INVALID", "HOLQA_DECLARATION_INVALID"]);
  });
});

describe("idempotency option", () => {
  it("records the policy with defaults and rejects malformed settings", () => {
    const { orders, files } = shop();
    expect(getHandlerDescriptor(orders.consume({ id: "a", idempotency: true, handler: () => {} }))?.definition.idempotency).toEqual({ key: "delivery", retentionSeconds: 86_400, leaseSeconds: 30 });
    expect(getHandlerDescriptor(files.onObjectCreated({ id: "b", idempotency: { key: ({ object }) => object.key, retentionSeconds: 60, leaseSeconds: 10 }, handler: () => {} }))?.definition.idempotency).toEqual({ key: "custom", retentionSeconds: 60, leaseSeconds: 10 });
    expect(getHandlerDescriptor(orders.consume({ id: "c", idempotency: false, handler: () => {} }))?.definition).not.toHaveProperty("idempotency");
    expect(thrownCodes(() => orders.consume({ id: "d", idempotency: { key: "x" as never, leaseSeconds: 0 }, handler: () => {} }))).toEqual(["HOLQA_DECLARATION_INVALID", "HOLQA_DECLARATION_INVALID"]);
  });

  it("runs a message once per key, skips completed duplicates and retries keys another delivery holds", async () => {
    const { app, orders } = shop();
    const store = createMemoryIdempotencyStore({ now: () => 0 });
    const unbind = bindApp(getAppDescriptor(app)!, { ...createTestBinding(), idempotency: store });
    const seen: string[] = [];
    const consumer = orders.consume({ id: "orders.process", idempotency: true, handler: ({ message }) => {
      seen.push(message.orderId);
    } });
    const delivery = createContext({ attempt: 1, messageId: "m-1" });
    await invoke(consumer, { orderId: "o-1" }, delivery);
    await invoke(consumer, { orderId: "o-1" }, createContext({ attempt: 1, messageId: "m-1" }));
    expect(seen).toEqual(["o-1"]);
    await store.begin("orders.process", "m-2", { leaseMs: 1000 });
    const held = await invoke(consumer, { orderId: "o-2" }, createContext({ attempt: 1, messageId: "m-2" })).catch((error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
    expect(held).toEqual(["HOLQA_IDEMPOTENCY_IN_PROGRESS"]);
    unbind();
  });

  it("releases the key when the handler fails, so the retry runs it again", async () => {
    const { app, orders } = shop();
    const unbind = bindApp(getAppDescriptor(app)!, { ...createTestBinding(), idempotency: createMemoryIdempotencyStore() });
    let calls = 0;
    const consumer = orders.consume({ id: "orders.process", idempotency: true, handler: () => {
      calls += 1;
      if (calls === 1)
        throw new Error("first attempt fails");
    } });
    await expect(invoke(consumer, { orderId: "o-1" }, createContext({ attempt: 1, messageId: "m-1" }))).rejects.toThrow("first attempt fails");
    await invoke(consumer, { orderId: "o-1" }, createContext({ attempt: 2, messageId: "m-1" }));
    await invoke(consumer, { orderId: "o-1" }, createContext({ attempt: 3, messageId: "m-1" }));
    expect(calls).toBe(2);
    unbind();
  });

  it("renews its claim while the handler runs, so a long handler keeps its key", async () => {
    const { app, orders } = shop();
    const store = createMemoryIdempotencyStore();
    const unbind = bindApp(getAppDescriptor(app)!, { ...createTestBinding(), idempotency: store });
    let observed: string | undefined;
    const consumer = orders.consume({ id: "orders.slow", idempotency: { leaseSeconds: 1 }, handler: async () => {
      await Bun.sleep(1_200);
      observed = (await store.begin("orders.slow", "m-1", { leaseMs: 1_000 })).status;
    } });
    await invoke(consumer, { orderId: "o-1" }, createContext({ attempt: 1, messageId: "m-1" }));
    expect(observed).toBe("in-progress");
    expect((await store.begin("orders.slow", "m-1", { leaseMs: 1_000 })).status).toBe("completed");
    unbind();
  });

  it("keys on business data with a key function, catching duplicates sent as separate messages", async () => {
    const { app, files } = shop();
    const unbind = bindApp(getAppDescriptor(app)!, { ...createTestBinding(), idempotency: createMemoryIdempotencyStore() });
    const keys: string[] = [];
    const handler = files.onObjectCreated({ id: "files.created", idempotency: { key: ({ object }) => object.key }, handler: ({ object }) => {
      keys.push(object.key);
    } });
    await invoke(handler, { key: "a.txt", size: 1 }, createContext({ eventId: "e-1", eventTime: "2026-01-01T00:00:00.000Z", attempt: 1 }));
    await invoke(handler, { key: "a.txt", size: 1 }, createContext({ eventId: "e-2", eventTime: "2026-01-01T00:00:00.000Z", attempt: 1 }));
    expect(keys).toEqual(["a.txt"]);
    unbind();
  });

  it("fails explicitly on a binding without an idempotency store, and for unusable keys", async () => {
    const { app, orders } = shop();
    const unbind = bindApp(getAppDescriptor(app)!, createTestBinding());
    const consumer = orders.consume({ id: "orders.process", idempotency: true, handler: () => {} });
    const codes = await invoke(consumer, { orderId: "o-1" }, createContext({ attempt: 1, messageId: "m-1" })).catch((error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
    expect(codes).toEqual(["HOLQA_BINDING_CAPABILITY_UNSUPPORTED"]);
    unbind();
    const second = shop();
    const unbindSecond = bindApp(getAppDescriptor(second.app)!, { ...createTestBinding(), idempotency: createMemoryIdempotencyStore() });
    const empty = second.orders.consume({ id: "orders.empty", idempotency: { key: () => "" }, handler: () => {} });
    const emptyCodes = await invoke(empty, { orderId: "o-1" }, createContext({ attempt: 1, messageId: "m-1" })).catch((error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
    expect(emptyCodes).toEqual(["HOLQA_OPERATION_INVALID"]);
    unbindSecond();
  });
});

describe("option types", () => {
  it("types key functions from the validated input and restricts publications to handles", () => {
    const { orders, files, cleanup } = shop();
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      orders.consume({
        id: "orders.typed",
        idempotency: {
          key: ({ message, delivery }) => {
            expectTypeOf(message).toEqualTypeOf<{ orderId: string }>();
            expectTypeOf(delivery.messageId).toEqualTypeOf<string>();
            return message.orderId;
          }
        },
        handler: ({ lineage }) => {
          expectTypeOf(lineage?.depth).toEqualTypeOf<number | undefined>();
        }
      });
      files.onObjectCreated({ id: "files.typed", idempotency: { key: ({ object, event }) => `${object.key}:${event.id}` }, handler: () => {} });
      // @ts-expect-error -- idempotency keys are strings.
      orders.consume({ id: "orders.number", idempotency: { key: () => 1 }, handler: () => {} });
      // @ts-expect-error -- publications are resource handles, not identifiers.
      orders.consume({ id: "orders.publishes", events: { publishes: ["orders"] }, handler: () => {} });
      files.onObjectDeleted({ id: "files.deleted.typed", idempotency: { key: ({ object }) => {
        expectTypeOf(object).toEqualTypeOf<DeletedObjectInfo>();
        return object.key;
      } }, handler: () => {} });
      // @ts-expect-error -- schedule handlers cannot declare idempotency.
      cleanup.handle({ id: "cleanup.idempotent", idempotency: true, handler: () => {} });
      // @ts-expect-error -- only queues and buckets receive published events.
      orders.consume({ id: "orders.schedule", events: { publishes: [cleanup] }, handler: () => {} });
      // @ts-expect-error -- a cycle allowance needs a justification.
      orders.consume({ id: "orders.cycle", events: { cycle: {} }, handler: () => {} });
    };
    expect(typeof neverCalled).toBe("function");
  });
});

describe("lineage", () => {
  it("passes the invocation's lineage to queue, object event and schedule handlers", async () => {
    const { orders, files, cleanup } = shop();
    const lineage = { correlationId: "c-1", causationId: "inv-0", rootId: "inv-0", depth: 2 };
    const received: unknown[] = [];
    const consumer = orders.consume({ id: "orders.process", handler: (context) => {
      received.push(context.lineage);
    } });
    const created = files.onObjectCreated({ id: "files.created", handler: (context) => {
      received.push(context.lineage);
    } });
    const run = cleanup.handle({ id: "cleanup.run", handler: (context) => {
      received.push(context.lineage);
    } });
    await invoke(consumer, { orderId: "o-1" }, { ...createContext({ attempt: 1, messageId: "m-1" }), lineage });
    await invoke(created, { key: "a", size: 1 }, { ...createContext({ eventId: "e-1", eventTime: "2026-01-01T00:00:00.000Z", attempt: 1 }), lineage });
    await invoke(run, undefined, { ...createContext({ scheduledTime: "2026-01-01T00:00:00.000Z" }), lineage });
    await invoke(consumer, { orderId: "o-1" }, createContext({ attempt: 1, messageId: "m-1" }));
    expect(received).toEqual([lineage, lineage, lineage, undefined]);
  });
});