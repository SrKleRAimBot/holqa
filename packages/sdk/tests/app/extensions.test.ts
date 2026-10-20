import type { RuntimeBinding } from "@holqa/core";

import {
  bindApp,
  defineExtension,
  getAppDescriptor
} from "@holqa/core";
import {
  createTestBinding,
  thrownCodes
} from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import { defineApp } from "@/index";

/** A cache the application requires. */
const cache = defineExtension<{ readonly get: (key: string) => Promise<string | undefined> }>({ id: "example.cache", version: 1 });

/** A search index the application can do without. */
const search = defineExtension<{ readonly query: (text: string) => Promise<readonly string[]> }>({ id: "example.search", version: 2 });

/** An extension the application does not declare. */
const flags = defineExtension<{ readonly enabled: (flag: string) => boolean }>({ id: "example.flags", version: 1 });

describe("defineApp extensions", () => {
  it("records required and optional extensions in the descriptor, sorted by identifier", () => {
    const app = defineApp({ name: "shop", resources: {}, extensions: { required: [cache], optional: [search] } });
    expect(getAppDescriptor(app)!.extensions).toEqual([{ id: "example.cache", version: 1, required: true }, { id: "example.search", version: 2, required: false }]);
    expect(getAppDescriptor(defineApp({ name: "plain", resources: {} }))!.extensions).toBeUndefined();
  });

  it("gives typed access through the binding: require for required extensions, get for declared ones", async () => {
    const app = defineApp({ name: "shop", resources: {}, extensions: { required: [cache], optional: [search] } });
    const binding: RuntimeBinding = { ...createTestBinding(), extensions: { provided: { "example.cache": 1 }, resolve: () => ({ get: async (key: string) => `v:${key}` }) } };
    const unbind = bindApp(getAppDescriptor(app)!, binding);
    try {
      expect(await app.extensions.require(cache).get("a")).toBe("v:a");
      expect(app.extensions.get(search)).toBeUndefined();
      expectTypeOf(app.extensions.require(cache)).toEqualTypeOf<{ readonly get: (key: string) => Promise<string | undefined> }>();
      expectTypeOf(app.extensions.get(search)).toEqualTypeOf<{ readonly query: (text: string) => Promise<readonly string[]> } | undefined>();
    } finally {
      unbind();
    }
  });

  it("rejects requiring an optional or undeclared extension at compile time", () => {
    const app = defineApp({ name: "shop", resources: {}, extensions: { required: [cache], optional: [search] } });
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- Optional extensions can only be read with get.
      app.extensions.require(search);
      // @ts-expect-error -- The application does not declare this extension.
      app.extensions.get(flags);
    };
    expect(neverCalled).toBeFunction();
  });

  it("rejects malformed and duplicate declarations", () => {
    expect(thrownCodes(() => defineApp({ name: "shop", resources: {}, extensions: { required: [cache], optional: [cache] } }))).toEqual(["HOLQA_DECLARATION_INVALID"]);
    expect(thrownCodes(() => defineApp({ name: "shop", resources: {}, extensions: { required: [{ id: "x" }] } } as never))).toEqual(["HOLQA_DECLARATION_INVALID"]);
    expect(thrownCodes(() => defineApp({ name: "shop", resources: {}, extensions: [] } as never))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });

  it("fails outside a runtime", () => {
    const app = defineApp({ name: "shop", resources: {}, extensions: { required: [cache] } });
    expect(thrownCodes(() => app.extensions.require(cache))).toEqual(["HOLQA_RUNTIME_NOT_BOUND"]);
  });
});