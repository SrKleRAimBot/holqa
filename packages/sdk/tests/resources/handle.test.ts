import type {
  AnyResource,
  BucketHandle,
  QueueHandle,
  ResourceAliasesOfKind,
  ResourceById,
  ResourceIdOf,
  ResourceIds
} from "@/index";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";
import { z } from "zod";

import {
  bucket,
  defineResources,
  queue
} from "@/index";

/** A group of resources for the handle type utilities. */
const resources = defineResources({
  orders: queue({ id: "order-processing", message: z.object({ orderId: z.string() }), schemaVersion: 1 }),
  refunds: queue({ id: "refunds", message: z.object({ amount: z.number() }), schemaVersion: 1 }),
  files: bucket({ id: "files", access: "private" })
});

describe("resource handle types", () => {
  it("keeps the alias for access and the identifier for identity", () => {
    expectTypeOf<ResourceIdOf<typeof resources.orders>>().toEqualTypeOf<"order-processing">();
    expectTypeOf<ResourceIds<typeof resources>>().toEqualTypeOf<"order-processing" | "refunds" | "files">();
    expectTypeOf<ResourceById<typeof resources, "files">>().toEqualTypeOf<BucketHandle<"files">>();
    expectTypeOf<ResourceAliasesOfKind<typeof resources, "queue">>().toEqualTypeOf<"orders" | "refunds">();
    expect(resources.orders.id).toBe("order-processing");
  });

  it("accepts every concrete handle as AnyResource without merging message types", () => {
    expectTypeOf(resources.orders).toExtend<AnyResource>();
    expectTypeOf(resources.files).toExtend<AnyResource>();
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- handles are not interchangeable across message types.
      const wrong: QueueHandle<"order-processing", z.ZodObject<{ amount: z.ZodNumber }>> = resources.orders;
      void wrong;
      // @ts-expect-error -- an identifier that is not declared cannot be looked up.
      void (null as unknown as ResourceById<typeof resources, "payments">);
    };
    expect(typeof neverCalled).toBe("function");
  });
});