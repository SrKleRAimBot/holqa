import type { BindingsDefinition } from "@/index";

import { diagnosticsOf } from "@holqa/core";
import {
  createApp,
  testPlatform,
  testQueueProvider
} from "@test/support/fixtures";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  defineBindings,
  isBindingsDefinition
} from "@/define-bindings";

/**
 * Runs a function that must throw and returns the codes it threw.
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

describe("defineBindings", () => {
  it("returns a frozen configuration that names its application and opens nothing", () => {
    const events: string[] = [];
    const app = createApp();
    const bindings = defineBindings(app, { name: "staging", defaults: testPlatform({ events: events as never }), resources: { orders: testQueueProvider() } });
    expect(bindings.type).toBe("holqa.bindings");
    expect(bindings.name).toBe("staging");
    expect(String(bindings.app.name)).toBe("shop");
    expect(Object.keys(bindings.resources)).toEqual(["orders"]);
    expect(Object.isFrozen(bindings)).toBe(true);
    expect(events).toEqual([]);
    expect(isBindingsDefinition(bindings)).toBe(true);
    expect(isBindingsDefinition({ type: "holqa.bindings" })).toBe(false);
    expectTypeOf(bindings).toEqualTypeOf<BindingsDefinition<ReturnType<typeof createApp>>>();
  });

  it("defaults the name to \"default\"", () => {
    expect(defineBindings(createApp(), { defaults: testPlatform() }).name).toBe("default");
  });

  it("rejects values that are not applications", () => {
    expect(codesOf(() => defineBindings({ resources: {} }, {}))).toEqual(["HOLQA_APP_INVALID"]);
  });

  it("rejects malformed configurations at run time, one diagnostic per problem", () => {
    const app = createApp();
    expect(codesOf(() => defineBindings(app, { defaults: testPlatform(), name: "Bad Name", resources: [] as never, extra: true } as never))).toEqual([
      "HOLQA_BINDING_CONFIG_INVALID",
      "HOLQA_BINDING_CONFIG_INVALID",
      "HOLQA_BINDING_CONFIG_INVALID"
    ]);
    expect(codesOf(() => defineBindings(app, { defaults: testPlatform(), services: { flags: testPlatform() } } as never))).toEqual(["HOLQA_BINDING_CONFIG_INVALID"]);
  });
});

describe("defineBindings types", () => {
  it("accepts a provider for each resource's kind, by identifier, and kind-wide defaults", () => {
    const app = createApp();
    const bindings = defineBindings(app, { kinds: { queue: testQueueProvider() }, resources: { files: testPlatform(), nightly: testPlatform(), api: testPlatform() } });
    expect(bindings.kinds.queue?.name).toBe("broker");
  });

  it("rejects a provider that does not bind the resource's kind", () => {
    const app = createApp();
    // @ts-expect-error A queue provider cannot bind the bucket "files".
    defineBindings(app, { defaults: testPlatform(), resources: { files: testQueueProvider() } });
    // @ts-expect-error A queue provider cannot bind every schedule.
    defineBindings(app, { defaults: testPlatform(), kinds: { schedule: testQueueProvider() } });
  });

  it("rejects resources and kinds the application does not declare", () => {
    const app = createApp();
    // @ts-expect-error "payments" is not declared.
    expect(() => defineBindings(app, { defaults: testPlatform(), resources: { orders: testQueueProvider(), payments: testQueueProvider() } })).not.toThrow();
  });

  it("rejects configurations that leave a resource without any provider", () => {
    const app = createApp();
    // @ts-expect-error The bucket, schedule and API have no provider and there is no default.
    defineBindings(app, { kinds: { queue: testQueueProvider() } });
    defineBindings(app, { kinds: { queue: testQueueProvider() }, resources: { files: testPlatform(), nightly: testPlatform(), api: testPlatform() } });
  });

  it("rejects a service provider that does not supply the service", () => {
    const app = createApp();
    // @ts-expect-error A queue provider does not supply telemetry.
    defineBindings(app, { defaults: testPlatform(), services: { telemetry: testQueueProvider() } });
    defineBindings(app, { defaults: testPlatform(), services: { telemetry: [testPlatform()], config: testPlatform() } });
  });
});