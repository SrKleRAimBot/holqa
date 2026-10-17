import type {
  Described,
  ResourceDescriptor
} from "@/index";

import {
  appDescriptor,
  id,
  queueDescriptor,
  stringSchema
} from "@test/support/descriptors";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  getAppDescriptor,
  getConfigDescriptor,
  getDescriptor,
  getHandlerDescriptor,
  getResourceDescriptor
} from "@/protocol/read";

/**
 * Wraps a descriptor the way SDK values carry it.
 *
 * @param descriptor - Any value to place under the descriptor key.
 * @returns An object carrying the value under `~holqa`.
 */
function carrying(descriptor: unknown): { readonly "~holqa": unknown } {
  return { "~holqa": descriptor };
}

/** A hand-built handler descriptor, as another copy of the package would produce. */
const handler = {
  protocol: 1,
  type: "handler",
  definition: { id: id("orders.process"), trigger: { kind: "queue.message", resource: { kind: "queue", id: id("orders") }, options: {} } },
  schemas: { message: stringSchema },
  invoke: async () => undefined
} as const;

describe("descriptor readers", () => {
  it("read hand-built descriptors structurally, without instanceof or shared symbols", () => {
    const resource = queueDescriptor("orders");
    const app = appDescriptor([resource]);
    expect(getDescriptor(carrying(resource))).toBe(resource);
    expect(getResourceDescriptor(carrying(resource))).toBe(resource);
    expect(getAppDescriptor(carrying(app))).toBe(app);
    expect(getHandlerDescriptor(carrying(handler))).toBe(handler as never);
    expect(getConfigDescriptor(carrying(app.config[0]))).toBe(app.config[0]);
    expect(getDescriptor(Object.assign(() => {}, { "~holqa": resource }))).toBe(resource);
  });

  it("narrow to the requested descriptor type", () => {
    const resource = queueDescriptor("orders");
    expect(getAppDescriptor(carrying(resource))).toBeUndefined();
    expect(getHandlerDescriptor(carrying(resource))).toBeUndefined();
    expect(getConfigDescriptor(carrying(resource))).toBeUndefined();
    expectTypeOf(getResourceDescriptor).returns.toEqualTypeOf<ResourceDescriptor | undefined>();
  });

  it("reject other protocol versions and unknown kinds", () => {
    expect(getDescriptor(carrying({ ...queueDescriptor("orders"), protocol: 2 }))).toBeUndefined();
    expect(getDescriptor(carrying({ ...queueDescriptor("orders"), kind: "topic" }))).toBeUndefined();
    expect(getDescriptor(carrying({ ...handler, definition: { ...handler.definition, trigger: { ...handler.definition.trigger, kind: "topic.message" } } }))).toBeUndefined();
    expect(getDescriptor(carrying({ ...queueDescriptor("orders"), type: "binding" }))).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    "orders",
    {},
    carrying(null),
    carrying({ protocol: 1 }),
    carrying({ protocol: 1, type: "resource", kind: "queue" }),
    carrying({ protocol: 1, type: "handler", definition: { id: "x", trigger: { kind: "queue.message" } }, schemas: {} }),
    carrying({ protocol: 1, type: "config", name: "TOKEN", sensitive: "yes", schema: stringSchema }),
    carrying({ protocol: 1, type: "app", name: "demo", handlers: {}, resources: [], config: [] }),
    carrying({ ...appDescriptor([]), resources: [null] }),
    carrying({ ...queueDescriptor("orders"), id: "Not Valid" }),
    carrying({ ...queueDescriptor("orders"), schemas: { message: { parse: String } } }),
    carrying({ ...appDescriptor([]), config: [{ type: "resource" }] }),
    carrying({ ...handler, definition: { ...handler.definition, trigger: { ...handler.definition.trigger, resource: { kind: "bucket", id: "orders" } } } })
  ])("reject malformed value %p", (value) => {
    expect(getDescriptor(value)).toBeUndefined();
  });

  it("type values that carry descriptors", () => {
    const value: Described<ResourceDescriptor> = { "~holqa": queueDescriptor("orders") };
    expect(getResourceDescriptor(value)?.kind).toBe("queue");
  });
});