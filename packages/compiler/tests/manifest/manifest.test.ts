import type {
  CompileApplicationResult,
  Manifest,
  ManifestResource,
  ManifestResourceOf,
  ManifestTrigger,
  ManifestTriggerOf
} from "@/index";

import { parseResourceId } from "@holqa/core";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import { manifestJsonSchema } from "@/index";
import { validateJsonSchema } from "@/validation/json-schema-validator";

describe("manifest types", () => {
  it("narrow resources and triggers on their kind", () => {
    /**
     * Reads a queue's schema version through narrowing.
     *
     * @param resource - Any manifest resource.
     * @returns The schema version of a queue.
     */
    const narrowResource = (resource: ManifestResource): number | undefined => resource.kind === "queue" ? resource.config.schemaVersion : undefined;
    /**
     * Reads a route's path through narrowing.
     *
     * @param trigger - Any manifest trigger.
     * @returns The path of an HTTP route.
     */
    const narrowTrigger = (trigger: ManifestTrigger): string | undefined => trigger.kind === "http.route" ? trigger.options.path : undefined;
    expectTypeOf(narrowResource).returns.toEqualTypeOf<number | undefined>();
    expectTypeOf(narrowTrigger).returns.toEqualTypeOf<string | undefined>();
    expectTypeOf<ManifestTriggerOf<"queue.message">["resource"]["kind"]>().toEqualTypeOf<"queue">();
  });

  it("reject a configuration that belongs to another kind", () => {
    // @ts-expect-error A bucket's empty config is not a queue's config.
    const queue: ManifestResourceOf<"queue">["config"] = {};
    // @ts-expect-error Schedules have no `access` requirement.
    const schedule: ManifestResourceOf<"schedule">["requirements"] = { access: "private" };
    expect([queue, schedule]).toHaveLength(2);
  });

  it("expose a manifest only after a successful compilation", () => {
    /**
     * Reads the manifest after checking the result.
     *
     * @param result - A compilation result.
     * @returns The manifest of a successful compilation.
     */
    const read = (result: CompileApplicationResult): Manifest | undefined => result.ok ? result.manifest : undefined;
    expectTypeOf(read).returns.toEqualTypeOf<Manifest | undefined>();
    /**
     * Reads the manifest without checking the result, which must not compile.
     *
     * @param result - A compilation result.
     * @returns Nothing usable.
     */
    // @ts-expect-error `manifest` does not exist until `ok` is checked.
    const unchecked = (result: CompileApplicationResult): unknown => result.manifest;
    expect(typeof unchecked).toBe("function");
  });
});

describe("manifest JSON Schema", () => {
  it.each(["orders", "order-processing", "orders.process", "a1", "Orders", "1orders", "orders-", "a..b", "x".repeat(63), "x".repeat(64), ""])("accepts identifier %p exactly when parseResourceId does", (candidate) => {
    const document = { manifestVersion: 1, application: { name: candidate }, runtime: "bun", resources: [], handlers: [], config: [], requiredCapabilities: [], schemas: {} };
    expect(validateJsonSchema(manifestJsonSchema, document).length === 0).toBe(parseResourceId(candidate).ok);
  });
});