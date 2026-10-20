import type {
  AppDescriptor,
  ProviderContext
} from "@holqa/core";

import type { AppCache } from "@/extensions/app-cache";

import {
  diagnosticsOf,
  getAppDescriptor,
  validateProvider
} from "@holqa/core";
import { application } from "@test/support/fixtures";

import {
  describe,
  expect,
  it
} from "bun:test";

import { ManualClock } from "@/clock";
import {
  appCacheExtension,
  localAppCache
} from "@/extensions/app-cache";

/**
 * Opens a local application cache with a manual clock.
 *
 * @param maxEntries - The size bound.
 * @returns The cache, its clock and a stop function.
 */
async function openCache(maxEntries = 3): Promise<{ readonly cache: AppCache; readonly clock: ManualClock; readonly stop: () => Promise<void> }> {
  const clock = new ManualClock();
  const app: AppDescriptor = getAppDescriptor(application([]))!;
  const context: ProviderContext = { app, environment: "test", resources: [], credential: () => "", signal: new AbortController().signal, log: () => {} };
  const instance = await localAppCache({ maxEntries, clock }).open(context);
  return { cache: instance.extensions![appCacheExtension.id] as AppCache, clock, stop: () => instance.stop!({ signal: new AbortController().signal }) };
}

/**
 * Collects the codes a promise rejects with.
 *
 * @param promise - A promise expected to reject with a Holqa error.
 * @returns The diagnostic codes, empty when it resolved.
 */
async function codes(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return diagnosticsOf(error).map(diagnostic => diagnostic.code);
  }
  return [];
}

describe("localAppCache", () => {
  it("is a valid service provider that implements holqa.app-cache version 1 and needs no credentials", () => {
    const provider = localAppCache();
    expect(validateProvider(provider)).toEqual([]);
    expect(provider.extensions).toEqual([{ id: "holqa.app-cache", version: 1 }]);
    expect(provider.credentials).toBeUndefined();
    expect(appCacheExtension).toMatchObject({ type: "holqa.extension", id: "holqa.app-cache", version: 1 });
  });

  it("stores, reads, replaces and deletes values, expiring them by the clock", async () => {
    const { cache, clock, stop } = await openCache();
    await cache.set("a", "1", { ttlSeconds: 10 });
    expect(await cache.get("a")).toBe("1");
    clock.advance(9_999);
    expect(await cache.get("a")).toBe("1");
    clock.advance(1);
    expect(await cache.get("a")).toBeUndefined();
    await cache.set("b", "2");
    await cache.set("b", "3");
    expect(await cache.get("b")).toBe("3");
    expect(await cache.delete("b")).toBe(true);
    expect(await cache.delete("b")).toBe(false);
    await stop();
  });

  it("evicts the least recently used entry beyond its bound", async () => {
    const { cache, stop } = await openCache(2);
    await cache.set("a", "1");
    await cache.set("b", "2");
    await cache.get("a");
    await cache.set("c", "3");
    expect([await cache.get("a"), await cache.get("b"), await cache.get("c")]).toEqual(["1", undefined, "3"]);
    await stop();
  });

  it("rejects invalid input and use after stop", async () => {
    const { cache, stop } = await openCache();
    expect(await codes(cache.set("", "x"))).toEqual(["HOLQA_OPERATION_INVALID"]);
    expect(await codes(cache.set("k", 1 as never))).toEqual(["HOLQA_OPERATION_INVALID"]);
    expect(await codes(cache.set("k", "v", { ttlSeconds: 0 }))).toEqual(["HOLQA_OPERATION_INVALID"]);
    await cache.set("k", "v");
    await stop();
    expect(await codes(cache.get("k"))).toEqual(["HOLQA_RUNTIME_NOT_RUNNING"]);
  });

  it("validates its settings", () => {
    let thrown: string[] = [];
    try {
      localAppCache({ maxEntries: 0 });
    } catch (error) {
      thrown = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(thrown).toEqual(["HOLQA_BINDING_CONFIG_INVALID"]);
  });
});