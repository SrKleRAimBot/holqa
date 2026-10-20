import type { InvocationContext } from "@holqa/core";

import { getHandlerDescriptor } from "@holqa/core";
import { processOrder } from "@test/fixtures/orders";
import {
  describe,
  expect,
  it
} from "bun:test";

import { FaultPlan } from "@/app/faults";

/** A context for calling `invoke` outside a runtime. */
const context = { invocationId: "inv-1", signal: new AbortController().signal, metadata: { attempt: 1, messageId: "m-1" }, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } } as InvocationContext<object>;

describe("FaultPlan", () => {
  it("fails the next invocations of a handler, then lets them through", async () => {
    const plan = new FaultPlan();
    const registration = plan.instrument(processOrder);
    const invoke = getHandlerDescriptor(registration)!.invoke as (input: unknown, context: InvocationContext<object>) => Promise<unknown>;
    plan.add("orders.process", { times: 2, error: () => new Error("injected") });
    expect(plan.remaining("orders.process")).toBe(2);
    await expect(invoke({ orderId: "o" }, context)).rejects.toThrow("injected");
    await expect(invoke({ orderId: "o" }, context)).rejects.toThrow("injected");
    expect(plan.remaining("orders.process")).toBe(0);
    // Without an injected failure the real handler runs; outside a runtime its handle is unbound.
    await expect(invoke({ orderId: "o" }, context)).rejects.toThrow("HOLQA_RUNTIME_NOT_BOUND");
  });

  it("keeps the handler's identity and leaves other values alone", () => {
    const plan = new FaultPlan();
    expect(getHandlerDescriptor(plan.instrument(processOrder))?.definition).toBe(getHandlerDescriptor(processOrder)!.definition);
    expect(plan.instrument("not a handler")).toBe("not a handler");
  });

  it("rejects counts that are not positive integers and can be cleared", () => {
    const plan = new FaultPlan();
    expect(() => plan.add("orders.process", { times: 0 })).toThrow(RangeError);
    plan.add("orders.process");
    plan.clear();
    expect(plan.remaining("orders.process")).toBe(0);
  });
});