import type { orderPlaced } from "@test/fixtures/shop/contracts/order";
// Acceptance tests for the application model: a typed resource is declared in
// infra.ts (with parts of the registry in other modules), exported, imported
// by handler modules, and used with full TypeScript feedback. No generated
// code, development server or infrastructure is involved. `tsc --noEmit`
// (pnpm typecheck) enforces the type assertions; bun:test runs the rest.
import type { PlaceOrderInput } from "@test/fixtures/shop/handlers/place-order";

import type { z } from "zod";
import type {
  QueueHandle,
  QueueMessageOutput,
  ResourceById,
  ResourceIds
} from "@/index";

import {
  bindApp,
  getAppDescriptor,
  getHandlerDescriptor
} from "@holqa/core";
import { placeOrder } from "@test/fixtures/shop/handlers/place-order";
import processOrder, { processed } from "@test/fixtures/shop/handlers/process-order";
import reindex from "@test/fixtures/shop/handlers/reindex";
import app, {
  env,
  resources
} from "@test/fixtures/shop/infra";
import {
  createContext,
  createTestBinding
} from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

describe("types flow from infra.ts to other modules", () => {
  it("preserves the exact handle types under their aliases", () => {
    expectTypeOf(resources.orders).toEqualTypeOf<QueueHandle<"order-placed", typeof orderPlaced>>();
    expectTypeOf(resources.orders.id).toEqualTypeOf<"order-placed">();
    expectTypeOf(resources.api.kind).toEqualTypeOf<"http.api">();
    expectTypeOf(resources.images.id).toEqualTypeOf<"catalog-images">();
    expectTypeOf<ResourceIds<typeof resources>>().toEqualTypeOf<"shop-api" | "order-placed" | "nightly-report" | "catalog-images" | "catalog-reindex">();
    expectTypeOf<ResourceById<typeof resources, "catalog-reindex">>().toEqualTypeOf<typeof resources.reindex>();
    expect(Object.keys(resources)).toEqual(["api", "orders", "nightly", "images", "reindex"]);
  });

  it("types producers with the schema input and consumers with the schema output", () => {
    expectTypeOf<PlaceOrderInput>().toEqualTypeOf<z.input<typeof orderPlaced>>();
    expectTypeOf<PlaceOrderInput["priority"]>().toEqualTypeOf<"normal" | "urgent" | undefined>();
    expectTypeOf<PlaceOrderInput["placedAt"]>().toEqualTypeOf<string>();
    expectTypeOf<QueueMessageOutput<typeof resources.orders>>().toEqualTypeOf<z.output<typeof orderPlaced>>();
    expectTypeOf<QueueMessageOutput<typeof resources.orders>["placedAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<QueueMessageOutput<typeof resources.orders>["lines"][number]["sku"]>().toEqualTypeOf<string & z.core.$brand<"Sku">>();
  });

  it("gives TypeScript feedback for wrong messages in importing modules", () => {
    const order = { orderId: "o-1", lines: [{ sku: "A-1", quantity: 1 }], placedAt: "2026-10-17T12:00:00Z" };
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = async (): Promise<void> => {
      // @ts-expect-error -- "low" is not a declared priority.
      await placeOrder({ ...order, priority: "low" });
      // @ts-expect-error -- `lines` is a required property.
      await placeOrder({ orderId: "o-1", placedAt: "2026-10-17T12:00:00Z" });
      // @ts-expect-error -- producers send the input form (an ISO string), not the decoded Date.
      await resources.orders.send({ ...order, placedAt: new Date() });
      // @ts-expect-error -- excess properties are rejected for object literals.
      await resources.orders.send({ ...order, discount: 5 });
      // @ts-expect-error -- `payments` is not a declared resource alias.
      void resources.payments;
      // @ts-expect-error -- HTTP API handles have no queue operations.
      void resources.api.send;
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("types configuration values with each schema's output", () => {
    expectTypeOf(env).toEqualTypeOf<{ readonly DATABASE_URL: string; readonly LOG_LEVEL: "debug" | "info" | "warn"; readonly PORT: number }>();
  });
});

describe("the declared application at run time", () => {
  it("describes every resource, configuration entry and discovery pattern", () => {
    const descriptor = getAppDescriptor(app)!;
    expect<string>(descriptor.name).toBe("shop");
    expect(descriptor.description).toBe("Type-inference fixture.");
    expect(descriptor.handlers).toEqual({ include: ["./handlers/*.ts"], exclude: [] });
    expect<unknown>(descriptor.resources.map(resource => [resource.kind, resource.id])).toEqual([
      ["http.api", "shop-api"],
      ["queue", "order-placed"],
      ["schedule", "nightly-report"],
      ["bucket", "catalog-images"],
      ["queue", "catalog-reindex"]
    ]);
    expect(descriptor.config.map(entry => [entry.name, entry.sensitive, entry.defaultValue])).toEqual([["DATABASE_URL", true, undefined], ["LOG_LEVEL", false, "info"], ["PORT", false, undefined]]);
  });

  it("separates each handler's declarative metadata from its implementation", () => {
    expect<unknown>(getHandlerDescriptor(processOrder)?.definition).toEqual({
      id: "orders.process",
      trigger: { kind: "queue.message", resource: { kind: "queue", id: "order-placed" }, options: { concurrency: 4 } }
    });
    expect<unknown>(getHandlerDescriptor(reindex)?.definition.trigger.resource).toEqual({ kind: "queue", id: "catalog-reindex" });
    expect<unknown>(JSON.parse(JSON.stringify(getHandlerDescriptor(processOrder)?.definition))).toEqual(getHandlerDescriptor(processOrder)?.definition);
  });

  it("sends from a producer module and delivers to a consumer module through one binding", async () => {
    const binding = createTestBinding();
    const unbind = bindApp(getAppDescriptor(app)!, binding);
    try {
      await placeOrder({ orderId: "o-1", lines: [{ sku: "A-1", quantity: 1 }], placedAt: "2026-10-17T12:00:00.000Z" });
      expect(binding.sent.map(({ queue, message }) => ({ queue, message }))).toEqual([{ queue: "order-placed", message: { orderId: "o-1", lines: [{ sku: "A-1", quantity: 1 }], placedAt: "2026-10-17T12:00:00.000Z" } }]);

      const descriptor = getHandlerDescriptor(processOrder);
      if (descriptor?.definition.trigger.kind !== "queue.message")
        throw new Error("expected a queue consumer");
      await (descriptor as typeof processOrder["~holqa"]).invoke(binding.sent[0]!.message, createContext({ attempt: 2, messageId: "m-1" }));
      expect(processed).toEqual([{ orderId: "o-1", placedAt: new Date("2026-10-17T12:00:00.000Z"), attempt: 2 }]);
    } finally {
      unbind();
    }
  });
});