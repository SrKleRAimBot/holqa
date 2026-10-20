import type {
  ExtensionApi,
  RuntimeBinding
} from "@/index";

import {
  appDescriptor,
  recordingBinding
} from "@test/support/descriptors";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import { bindApp } from "@/binding/bind";
import { diagnosticsOf } from "@/errors/holqa-error";
import {
  checkExtensions,
  defineExtension,
  findExtension,
  isExtensionDefinition,
  requireExtension
} from "@/extensions/extension";

/** The cache API of the tests. */
interface Cache {
  readonly get: (key: string) => Promise<string | undefined>;
}

const cache = defineExtension<Cache>({ id: "example.cache", version: 2, description: "A cache.", runtimes: ["bun"], dependsOn: [{ id: "example.clock", version: 1 }] });

/**
 * Collects the codes a function throws.
 *
 * @param run - The function expected to throw a Holqa error.
 * @returns The diagnostic codes.
 */
function codesOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    return diagnosticsOf(error).map(diagnostic => diagnostic.code);
  }
  return [];
}

/**
 * Builds an application that declares extensions, bound to a binding that provides some.
 *
 * @param provided - The provided versions.
 * @returns The bound application descriptor and the implementations.
 */
function boundApp(provided: Readonly<Record<string, number>>) {
  const app = { ...appDescriptor([]), extensions: [{ id: "example.cache", version: 2, required: true }, { id: "example.search", version: 1, required: false }] };
  const implementation: Cache = { get: async key => `cached ${key}` };
  const binding: RuntimeBinding = { ...recordingBinding(), extensions: { provided, resolve: id => id === "example.cache" ? implementation : undefined } };
  bindApp(app, binding);
  return { app, implementation };
}

describe("defineExtension", () => {
  it("creates a frozen, typed definition", () => {
    expect(cache).toEqual({ type: "holqa.extension", id: "example.cache", version: 2, description: "A cache.", runtimes: ["bun"], dependsOn: [{ id: "example.clock", version: 1 }] });
    expect(Object.isFrozen(cache)).toBe(true);
    expect(isExtensionDefinition(cache)).toBe(true);
    expect(isExtensionDefinition({ type: "holqa.extension", id: "x", version: 1 })).toBe(false);
    expectTypeOf<ExtensionApi<typeof cache>>().toEqualTypeOf<Cache>();
  });

  it.each([
    [{ id: "cache", version: 1 }],
    [{ id: "example.cache", version: 0 }],
    [{ id: "example.cache", version: 1, runtimes: [] }],
    [{ id: "example.cache", version: 1, dependsOn: [{ id: "x" }] }],
    [{ id: "example.cache", version: 1, config: {} }]
  ])("rejects %p", (options) => {
    expect(codesOf(() => defineExtension(options as never))).toContain("HOLQA_EXTENSION_INVALID");
  });
});

describe("checkExtensions", () => {
  it("requires required extensions in their version and warns about optional ones in another", () => {
    const app = { ...appDescriptor([]), extensions: [{ id: "example.cache", version: 2, required: true }, { id: "example.search", version: 1, required: false }] };
    expect(checkExtensions(app, { "example.cache": 2 }, "b")).toEqual([]);
    expect(checkExtensions(app, undefined, "b").map(diagnostic => [diagnostic.code, diagnostic.severity])).toEqual([["HOLQA_EXTENSION_MISSING", "error"]]);
    expect(checkExtensions(app, { "example.cache": 1, "example.search": 2 }, "b").map(diagnostic => [diagnostic.code, diagnostic.severity])).toEqual([["HOLQA_EXTENSION_INCOMPATIBLE", "error"], ["HOLQA_EXTENSION_INCOMPATIBLE", "warning"]]);
  });
});

describe("requireExtension and findExtension", () => {
  it("return the implementation of the declared version", async () => {
    const { app, implementation } = boundApp({ "example.cache": 2 });
    expect(requireExtension(app, cache)).toBe(implementation);
    expect(await requireExtension(app, cache).get("k")).toBe("cached k");
    expect(findExtension(app, defineExtension({ id: "example.search", version: 1 }))).toBeUndefined();
  });

  it("fail clearly for a missing or incompatible extension and outside a runtime", () => {
    expect(codesOf(() => requireExtension(boundApp({}).app, cache))).toEqual(["HOLQA_EXTENSION_MISSING"]);
    expect(codesOf(() => requireExtension(boundApp({ "example.cache": 3 }).app, cache))).toEqual(["HOLQA_EXTENSION_INCOMPATIBLE"]);
    expect(codesOf(() => findExtension(appDescriptor([]), cache))).toEqual(["HOLQA_RUNTIME_NOT_BOUND"]);
  });
});