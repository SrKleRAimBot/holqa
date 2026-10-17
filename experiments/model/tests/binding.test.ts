import type {
  AppDescriptor,
  RuntimeBinding
} from "@/index";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  bindApp,
  createBindingSlot,
  descriptorProtocol,
  errorCode,
  requireBinding
} from "@/index";

/**
 * Creates an unbound application descriptor.
 *
 * @returns A descriptor with an empty binding slot.
 */
function createApp(): AppDescriptor {
  return { protocol: descriptorProtocol, type: "app", name: "demo", handlers: [], resources: [], config: [], binding: createBindingSlot() };
}

/** A binding whose operations are never called in these tests. */
const binding: RuntimeBinding = {
  queue: () => ({ send: async () => {} }),
  bucket: () => ({ put: async () => {}, get: async () => undefined }),
  config: () => undefined
};

describe("runtime binding", () => {
  it("fails with HOLQA_RUNTIME_NOT_BOUND before a runtime binds the application", () => {
    let code: unknown;
    try {
      requireBinding(createApp(), "send");
    } catch (error) {
      code = errorCode(error);
    }
    expect(code).toBe("HOLQA_RUNTIME_NOT_BOUND");
  });

  it("binds once, rejects rebinding, and unbinds idempotently", () => {
    const app = createApp();
    const unbind = bindApp(app, binding);
    expect(requireBinding(app, "send")).toBe(binding);
    expect(() => bindApp(app, binding)).toThrow();
    unbind();
    unbind();
    expect(app.binding.current).toBeUndefined();
    expect(bindApp(app, binding)).toBeFunction();
  });
});