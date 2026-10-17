import {
  describe,
  expect,
  it
} from "bun:test";

import { createBindingSlot } from "@/binding";
import {
  descriptorKey,
  getAppDescriptor,
  getDescriptor,
  getHandlerDescriptor
} from "@/descriptors";

/** A minimal application descriptor value. */
const app = { [descriptorKey]: { protocol: 1, type: "app", name: "a", handlers: [], resources: [], config: [], binding: createBindingSlot() } };

describe("descriptors", () => {
  it("reads descriptors structurally, so copies from another package instance are recognized", () => {
    const foreignCopy = JSON.parse(JSON.stringify({ "~holqa": { protocol: 1, type: "resource", kind: "queue", id: "q", config: {}, schemas: {} } })) as unknown;
    expect(getDescriptor(foreignCopy)?.type).toBe("resource");
    expect(getAppDescriptor(app)?.name).toBe("a");
  });

  it("rejects unknown protocol versions, unknown types and non-objects", () => {
    expect(getDescriptor({ [descriptorKey]: { protocol: 2, type: "app" } })).toBeUndefined();
    expect(getDescriptor({ [descriptorKey]: { protocol: 1, type: "widget" } })).toBeUndefined();
    expect(getDescriptor("~holqa")).toBeUndefined();
    expect(getDescriptor(null)).toBeUndefined();
  });

  it("distinguishes handler and application descriptors", () => {
    expect(getHandlerDescriptor(app)).toBeUndefined();
    expect(getAppDescriptor({ [descriptorKey]: { protocol: 1, type: "handler" } })).toBeUndefined();
  });
});