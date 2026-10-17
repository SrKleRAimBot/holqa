import type { ResourceId } from "@/identity/resource-id";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  isResourceId,
  maxResourceIdLength,
  parseResourceId
} from "@/identity/resource-id";

describe("parseResourceId", () => {
  it.each([
    "orders",
    "order-processing",
    "orders.process",
    "v2",
    "a".repeat(maxResourceIdLength)
  ])("accepts %p", (candidate) => {
    const result = parseResourceId(candidate);
    expect(result).toEqual({ ok: true, value: candidate as ResourceId });
  });

  it.each([
    "",
    "Orders",
    "1orders",
    "orders-",
    "orders--queue",
    "orders..process",
    "orders_queue",
    "orders queue",
    "a".repeat(maxResourceIdLength + 1)
  ])("rejects %p with HOLQA_RESOURCE_ID_INVALID", (candidate) => {
    const result = parseResourceId(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOLQA_RESOURCE_ID_INVALID");
      expect(result.error.severity).toBe("error");
    }
  });

  it.each([
    [42, "number"],
    [null, "null"],
    [["orders"], "array"],
    [undefined, "undefined"]
  ])("rejects non-string input %p and names its type", (candidate, typeName) => {
    const result = parseResourceId(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain(typeName);
  });

  it("brands successful values so plain strings are not assignable", () => {
    const result = parseResourceId("orders");
    if (result.ok)
      expectTypeOf(result.value).toEqualTypeOf<ResourceId>();

    // @ts-expect-error A plain string is not a validated ResourceId.
    const unvalidated: ResourceId = "orders";
    expect(isResourceId(unvalidated)).toBe(true);
  });
});

describe("isResourceId", () => {
  it("mirrors parseResourceId", () => {
    expect(isResourceId("orders")).toBe(true);
    expect(isResourceId("Orders")).toBe(false);
    expect(isResourceId(1)).toBe(false);
  });
});