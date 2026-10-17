import type { SecondCopy } from "@test/support/second-copy";

import {
  appDescriptor,
  queueDescriptor,
  recordingBinding
} from "@test/support/descriptors";
import { loadSecondCopy } from "@test/support/second-copy";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "bun:test";

import * as core from "@/index";

describe("interoperability between two copies of @holqa/core", () => {
  let second: SecondCopy;

  beforeAll(async () => {
    second = await loadSecondCopy();
  });

  afterAll(() => {
    second.dispose();
  });

  it("loads a genuinely separate module instance", () => {
    expect(second.core.HolqaError).not.toBe(core.HolqaError);
    expect(second.core.descriptorKey).toBe(core.descriptorKey);
  });

  it("reads descriptors created through the other copy", () => {
    const app = appDescriptor([queueDescriptor("orders")]);
    const value = { [core.descriptorKey]: app };
    expect(second.core.getAppDescriptor(value)).toBe(app);
    expect(second.core.getResourceDescriptor({ [core.descriptorKey]: app.resources[0] })).toBe(app.resources[0]);
  });

  it("shares the binding slot, so a runtime using one copy serves handles using the other", async () => {
    const orders = queueDescriptor("orders");
    const app = appDescriptor([orders]);
    const binding = recordingBinding();
    const unbind = second.core.bindApp(app, binding);
    await core.resolveDriver(app, orders, "send").send("from the first copy");
    expect(binding.sent).toEqual(["from the first copy"]);
    unbind();
    expect(() => core.requireBinding(app, "send")).toThrow();
  });

  it("recognizes errors thrown by the other copy by shape, not by class", () => {
    let caught: unknown;
    try {
      second.core.failWith("HOLQA_RUNTIME_NOT_BOUND", "Not bound.");
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof core.HolqaError).toBe(false);
    expect(core.isHolqaError(caught)).toBe(true);
    expect(core.diagnosticsOf(caught).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_RUNTIME_NOT_BOUND"]);
  });
});