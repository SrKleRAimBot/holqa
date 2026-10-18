import type {
  DrivenResourceKind,
  QueueBackoff,
  ResourceKind,
  ResourceKindMap
} from "@/resources/kinds";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  isResourceKind,
  resourceKinds
} from "@/resources/kinds";

describe("resource kind registry", () => {
  it("lists every kind once, in a stable order", () => {
    expect(resourceKinds).toEqual(["queue", "bucket", "schedule", "http.api"]);
    expectTypeOf<ResourceKind>().toEqualTypeOf<"queue" | "bucket" | "schedule" | "http.api">();
  });

  it("distinguishes kinds with data-plane drivers", () => {
    expectTypeOf<DrivenResourceKind>().toEqualTypeOf<"queue" | "bucket">();
    expectTypeOf<ResourceKindMap["schedule"]["driver"]>().toEqualTypeOf<never>();
  });

  it("recognizes only registered kind names", () => {
    expect(isResourceKind("queue")).toBe(true);
    expect(isResourceKind("http.api")).toBe(true);
    expect(isResourceKind("topic")).toBe(false);
    expect(isResourceKind("toString")).toBe(false);
    expect(isResourceKind(1)).toBe(false);
  });

  it("types configuration and requirements per kind instead of as open dictionaries", () => {
    expectTypeOf<ResourceKindMap["queue"]["requirements"]>().toEqualTypeOf<{ readonly delivery: "at-least-once"; readonly maxAttempts?: number; readonly deadLetter: boolean; readonly backoff?: QueueBackoff }>();
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- queue configuration has no provider-specific fields.
      const config: ResourceKindMap["queue"]["config"] = { schemaVersion: 1, region: "somewhere" };
      void config;
    };
    expect(typeof neverCalled).toBe("function");
  });
});