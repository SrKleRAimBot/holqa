import type { PayloadError } from "@/wire/json-payload";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  decodeJsonPayload,
  encodeJsonPayload,
  toWirePayload
} from "@/wire/json-payload";

/**
 * Runs a function that must throw and returns the error.
 *
 * @param run - The function to run.
 * @returns The thrown payload error.
 */
function thrown(run: () => unknown): PayloadError {
  try {
    run();
  } catch (error) {
    return error as PayloadError;
  }
  throw new Error("Expected the function to throw.");
}

/** A class whose instances are not plain data. */
class Money {
  readonly amount = 1;
}

/**
 * Builds `[1, <hole>, 3]` without sparse-array syntax.
 *
 * @returns An array whose index 1 was never assigned.
 */
function holey(): number[] {
  const array: number[] = [];
  array[0] = 1;
  array[2] = 3;
  return array;
}

describe("toWirePayload", () => {
  it("copies plain JSON data and normalizes -0", () => {
    const value = { "a": [1, "x", true, null, { b: -0 }], "c d": "e" };
    const payload = toWirePayload(value, "test");
    expect(payload).toEqual({ "a": [1, "x", true, null, { b: 0 }], "c d": "e" });
    expect(payload).not.toBe(value);
    expect(Object.is((payload as { a: [unknown, unknown, unknown, unknown, { b: number }] }).a[4].b, 0)).toBe(true);
  });

  it("accepts null-prototype objects", () => {
    const value = Object.assign(Object.create(null) as object, { a: 1 });
    expect(toWirePayload(value, "test")).toEqual({ a: 1 });
  });

  it("omits undefined object properties, as JSON does", () => {
    expect(toWirePayload({ a: 1, note: undefined }, "test")).toEqual({ a: 1 });
  });

  it.each([
    ["a Date", { order: { placedAt: new Date(0) } }, "$.order.placedAt"],
    ["a Map", { m: new Map() }, "$.m"],
    ["a Set", [new Set()], "$[0]"],
    ["binary data", { file: new Uint8Array(2) }, "$.file"],
    ["a class instance", { price: new Money() }, "$.price"],
    ["a bigint", { n: 1n }, "$.n"],
    ["NaN", { n: Number.NaN }, "$.n"],
    ["Infinity", [Infinity], "$[0]"],
    ["a function", { f: () => 1 }, "$.f"],
    ["a symbol", { s: Symbol("s") }, "$.s"],
    ["undefined at the root", undefined, "$"],
    ["an undefined array entry", [1, undefined], "$[1]"],
    ["an array hole", holey(), "$[1]"],
    ["a quoted key", { "a b": new Date(0) }, "$[\"a b\"]"]
  ])("rejects %s with its JSON path", (_name, value, path) => {
    const error = thrown(() => toWirePayload(value, "message for queue \"orders\""));
    expect(error.code).toBe("HOLQA_PAYLOAD_NOT_SERIALIZABLE");
    expect(error.path).toBe(path);
    expect(error.diagnostics[0]!.details).toEqual({ subject: "message for queue \"orders\"", path });
  });

  it("rejects symbol keys and cycles", () => {
    expect(thrown(() => toWirePayload({ [Symbol("k")]: 1 }, "test")).code).toBe("HOLQA_PAYLOAD_NOT_SERIALIZABLE");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(thrown(() => toWirePayload(cyclic, "test")).path).toBe("$.self");
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { a: 1 };
    expect(toWirePayload([shared, shared], "test")).toEqual([{ a: 1 }, { a: 1 }]);
  });

  it("suggests portable alternatives and never echoes the value", () => {
    const error = thrown(() => toWirePayload({ when: new Date(0) }, "test"));
    expect(error.diagnostics[0]!.hint).toContain("ISO 8601");
    expect(error.message).not.toContain("1970");
  });
});

describe("encodeJsonPayload and decodeJsonPayload", () => {
  it("round-trip JSON data through UTF-8 bytes", () => {
    const bytes = encodeJsonPayload({ text: "héllo ✓" }, "test");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(decodeJsonPayload(bytes, "test")).toEqual({ text: "héllo ✓" });
    expect(decodeJsonPayload("[1]", "test")).toEqual([1]);
  });

  it("rejects invalid UTF-8 and invalid JSON with HOLQA_PAYLOAD_MALFORMED", () => {
    expect(thrown(() => decodeJsonPayload(new Uint8Array([0xFF, 0xFE]), "test")).code).toBe("HOLQA_PAYLOAD_MALFORMED");
    expect(thrown(() => decodeJsonPayload("{oops", "test")).code).toBe("HOLQA_PAYLOAD_MALFORMED");
  });

  it("keeps __proto__ as plain data instead of changing the prototype", () => {
    const value = decodeJsonPayload("{\"__proto__\":{\"polluted\":true}}", "test") as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe("__proto__ keys", () => {
  it("stay own properties, so what is validated is what is sent", () => {
    const payload = toWirePayload(JSON.parse("{\"__proto__\":{\"isAdmin\":true},\"id\":\"x\"}"), "test") as Record<string, unknown>;
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(Object.keys(payload)).toEqual(["__proto__", "id"]);
    expect(JSON.stringify(payload)).toBe("{\"__proto__\":{\"isAdmin\":true},\"id\":\"x\"}");
  });
});