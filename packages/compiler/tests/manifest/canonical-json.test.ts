import {
  describe,
  expect,
  it
} from "bun:test";

import {
  CanonicalJsonError,
  canonicalJsonStringify
} from "@/manifest/canonical-json";

describe("canonicalJsonStringify", () => {
  it("sorts object keys at every depth", () => {
    const text = canonicalJsonStringify({ b: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] });
    expect(text).toBe(JSON.stringify({ a: [{ c: 2, d: 1 }], b: { x: 2, y: 1 } }, null, 2));
  });

  it("is independent of key insertion order", () => {
    const first = canonicalJsonStringify({ id: "orders", kind: "queue", delivery: { maxAttempts: 5, deadLetter: true } });
    const second = canonicalJsonStringify({ delivery: { deadLetter: true, maxAttempts: 5 }, kind: "queue", id: "orders" });
    expect(first).toBe(second);
  });

  it("preserves array order", () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe("[\n  3,\n  1,\n  2\n]");
  });

  it("normalizes negative zero", () => {
    expect(canonicalJsonStringify({ value: -0 })).toBe("{\n  \"value\": 0\n}");
  });

  it("does not emit a trailing newline", () => {
    expect(canonicalJsonStringify({})).toBe("{}");
  });

  it.each([
    ["undefined property", { value: undefined }, "$.value"],
    ["undefined array item", [1, undefined], "$[1]"],
    ["function", { handler: () => {} }, "$.handler"],
    ["bigint", { size: 1n }, "$.size"],
    ["NaN", { ratio: Number.NaN }, "$.ratio"],
    ["Infinity", { ratio: Number.POSITIVE_INFINITY }, "$.ratio"],
    ["Date", { at: new Date(0) }, "$.at"],
    ["Map", { lookup: new Map() }, "$.lookup"]
  ])("rejects %s with a located diagnostic", (_label, input, path) => {
    let caught: unknown;
    try {
      canonicalJsonStringify(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CanonicalJsonError);
    const error = caught as CanonicalJsonError;
    expect(error.diagnostic.code).toBe("HOLQA_MANIFEST_NOT_SERIALIZABLE");
    expect(error.message).toContain(path);
  });

  it("rejects circular references", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => canonicalJsonStringify(value)).toThrow(CanonicalJsonError);
  });

  it("allows the same object to appear in sibling positions", () => {
    const shared = { a: 1 };
    expect(() => canonicalJsonStringify({ left: shared, right: shared })).not.toThrow();
  });

  it("accepts objects without a prototype", () => {
    const value = Object.assign(Object.create(null) as object, { b: 1, a: 2 });
    expect(canonicalJsonStringify(value)).toBe("{\n  \"a\": 2,\n  \"b\": 1\n}");
  });
});