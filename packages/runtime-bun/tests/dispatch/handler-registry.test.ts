import type { RegisteredHandler } from "@/dispatch/dispatcher";

import { getHandlerDescriptor } from "@holqa/core";
import { scheduleHandler } from "@test/support/descriptors";

import {
  describe,
  expect,
  it
} from "bun:test";

import { HandlerRegistry } from "@/dispatch/handler-registry";

/**
 * Builds a registered handler for the registry.
 *
 * @param handlerId - Its identifier.
 * @returns The registered handler.
 */
function registered(handlerId: string): RegisteredHandler {
  const descriptor = getHandlerDescriptor(scheduleHandler(handlerId, "nightly", () => handlerId))!;
  return { definition: descriptor.definition, schemas: descriptor.schemas, invoke: descriptor.invoke as RegisteredHandler["invoke"] };
}

/**
 * Creates a registry of two handlers that records opened and released owners.
 *
 * @returns The registry and the recorded events.
 */
function createRegistry(): { readonly registry: HandlerRegistry; readonly events: string[] } {
  const events: string[] = [];
  const scope = { signal: new AbortController().signal, use: async () => undefined as never };
  const registry = new HandlerRegistry(new Map([["a", registered("a")], ["b", registered("b")]]), {
    open: (owner) => {
      events.push(`open ${JSON.stringify(owner)}`);
      return scope;
    },
    release: async (owner) => {
      events.push(`release ${JSON.stringify(owner)}`);
    },
    retired: (handlerId, version) => events.push(`retired ${handlerId} ${version}`)
  }, new Map([["a", "a.ts#a"]]));
  return { registry, events };
}

/**
 * The implementation every replacement installs.
 *
 * @returns A fixed text.
 */
const replacement = async (): Promise<string> => "replaced";

describe("HandlerRegistry", () => {
  it("replaces several handlers atomically as one registry version", () => {
    const { registry } = createRegistry();
    expect(registry.replace([{ handlerId: "a", invoke: replacement }, { handlerId: "b", invoke: replacement, source: "b.ts#b" }])).toEqual({ version: 2, handlers: ["a", "b"] });
    expect(registry.snapshot()).toEqual([
      { handlerId: "a", version: 2, source: "a.ts#a", active: 0, retiring: [] },
      { handlerId: "b", version: 2, source: "b.ts#b", active: 0, retiring: [] }
    ]);
  });

  it("replaces nothing when an entry is unknown or repeated", () => {
    const { registry } = createRegistry();
    expect(() => registry.replace([{ handlerId: "a", invoke: replacement }, { handlerId: "missing", invoke: replacement }])).toThrow("unknown handler");
    expect(() => registry.replace([{ handlerId: "a", invoke: replacement }, { handlerId: "a", invoke: replacement }])).toThrow("twice");
    expect(registry.stats()).toEqual({ version: 1, retiring: 0, retired: 0 });
  });

  it("keeps a replaced version until its pinned executions finish, then releases it once", async () => {
    const { registry, events } = createRegistry();
    const pinned = registry.pin("a");
    registry.replace([{ handlerId: "a", invoke: replacement }]);
    expect(registry.stats()).toMatchObject({ retiring: 1 });
    expect(registry.pin("a").version).toBe(2);
    pinned.release();
    pinned.release();
    await Bun.sleep(0);
    expect(registry.stats()).toMatchObject({ retiring: 0, retired: 1 });
    expect(events.filter(event => event.startsWith("release") || event.startsWith("retired"))).toEqual(["release {\"handlerId\":\"a\",\"version\":1}", "retired a 1"]);
  });
});