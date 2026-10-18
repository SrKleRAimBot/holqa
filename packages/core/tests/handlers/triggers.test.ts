import type {
  TriggerKind,
  TriggerKindMap
} from "@/handlers/triggers";
import type {
  HandlerDefinition,
  HandlerDescriptorOf,
  InvocationContext
} from "@/index";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  isTriggerKind,
  resourceKindOfTrigger,
  triggerKinds
} from "@/handlers/triggers";

describe("trigger kind registry", () => {
  it("lists every trigger kind and the resource kind it belongs to", () => {
    expect(triggerKinds).toEqual(["queue.message", "bucket.object-created", "schedule.tick", "http.route"]);
    expect(triggerKinds.map(resourceKindOfTrigger)).toEqual(["queue", "bucket", "schedule", "http.api"]);
    expectTypeOf(resourceKindOfTrigger("queue.message")).toEqualTypeOf<"queue">();
  });

  it("recognizes only registered trigger kinds", () => {
    expect(isTriggerKind("schedule.tick")).toBe(true);
    expect(isTriggerKind("queue")).toBe(false);
    expect(isTriggerKind(undefined)).toBe(false);
  });

  it("types handler definitions as JSON data discriminated by trigger kind", () => {
    expectTypeOf<HandlerDefinition["trigger"]["kind"]>().toEqualTypeOf<TriggerKind>();
    /**
     * Holds deliberate type errors checked by tsc; never executed.
     *
     * @param definition - A handler definition of any trigger kind.
     */
    const neverCalled = (definition: HandlerDefinition): void => {
      if (definition.trigger.kind === "http.route")
        expectTypeOf(definition.trigger.options.method).toEqualTypeOf<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">();
      if (definition.trigger.kind === "queue.message") {
        expectTypeOf(definition.trigger.resource.kind).toEqualTypeOf<"queue">();
        // @ts-expect-error -- queue triggers have no HTTP method.
        void definition.trigger.options.method;
      }
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("types the metadata a runtime passes to each trigger kind", () => {
    expectTypeOf<Parameters<HandlerDescriptorOf<"queue.message">["invoke"]>[1]>().toEqualTypeOf<InvocationContext<TriggerKindMap["queue.message"]["metadata"]>>();
    expectTypeOf<TriggerKindMap["schedule.tick"]["metadata"]>().toEqualTypeOf<{ readonly scheduledTime: string }>();
  });
});