import type { ConfigEntry } from "@/index";

import { thrownCodes } from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";
import { z } from "zod";

import {
  secret,
  variable
} from "@/index";

describe("secret", () => {
  it("declares a sensitive entry without reading any value", () => {
    const schema = z.string().min(16);
    const entry = secret(schema);
    expectTypeOf(entry).toEqualTypeOf<ConfigEntry<typeof schema, true>>();
    expect(entry).toEqual({ kind: "secret", schema, sensitive: true });
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it("rejects values that are not Standard Schemas", () => {
    expect(thrownCodes(() => secret({ parse: String } as never))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });
});

describe("variable", () => {
  it("keeps a JSON default typed as the schema input", () => {
    const entry = variable(z.enum(["debug", "info"]), { default: "info" });
    expect(entry.defaultValue).toBe("info");
    expect(entry.sensitive).toBe(false);
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- "trace" is not accepted by the schema.
      variable(z.enum(["debug", "info"]), { default: "trace" });
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("copies and freezes the default so later mutation cannot change the declaration", () => {
    const fallback = { retries: 3 };
    const entry = variable(z.object({ retries: z.number() }), { default: fallback });
    fallback.retries = 9;
    expect(entry.defaultValue).toEqual({ retries: 3 });
    expect(Object.isFrozen(entry.defaultValue)).toBe(true);
  });

  it("rejects defaults that are not JSON", () => {
    expect(thrownCodes(() => variable(z.any(), { default: new Date() as never }))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });
});