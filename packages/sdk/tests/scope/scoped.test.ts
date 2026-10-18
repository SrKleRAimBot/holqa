import type { ScopedDefinition } from "@holqa/core";

import { thrownCodes } from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import { scoped } from "@/index";

describe("scoped", () => {
  it("creates a frozen definition typed by what create returns", () => {
    /** Releases nothing; only its identity matters. */
    const dispose = (): void => {};
    const pool = scoped({ name: "pool", create: async () => ({ query: (sql: string) => sql.length }), dispose });
    expectTypeOf(pool).toEqualTypeOf<ScopedDefinition<{ query: (sql: string) => number }>>();
    expect(pool.name).toBe("pool");
    expect(pool.dispose).toBe(dispose);
    expect(Object.isFrozen(pool)).toBe(true);
    expect("dispose" in scoped({ name: "cache", create: () => new Map() })).toBe(false);
  });

  it("is pure: nothing is created when it is declared", () => {
    let created = 0;
    scoped({ name: "counter", create: () => ++created });
    expect(created).toBe(0);
  });

  it.each([
    ["an empty name", { name: " ", create: (): number => 1 }],
    ["a missing create", { name: "x" }],
    ["a non-function dispose", { name: "x", create: (): number => 1, dispose: "close" }]
  ])("rejects %s", (_label, options) => {
    expect(thrownCodes(() => scoped(options as never))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });
});