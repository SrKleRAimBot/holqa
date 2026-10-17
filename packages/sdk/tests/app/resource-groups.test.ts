import type {
  BucketHandle,
  ComposedResources,
  QueueHandle,
  ResourceRecord
} from "@/index";

import { thrownCodes } from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";
import { z } from "zod";

import {
  bucket,
  composeResources,
  defineApp,
  defineResources,
  queue
} from "@/index";

/** A message schema for the grouped queues. */
const invoiceIssued = z.object({ invoiceId: z.string() });

describe("defineResources", () => {
  it("returns the group unchanged with its exact type", () => {
    const group = { files: bucket({ id: "files", access: "private" }) };
    const defined = defineResources(group);
    expect(defined).toBe(group);
    expectTypeOf(defined).toEqualTypeOf<{ files: BucketHandle<"files"> }>();
  });

  it("composes into defineApp by spreading without losing types", () => {
    const billing = defineResources({ invoices: queue({ id: "invoices", message: invoiceIssued, schemaVersion: 1 }) });
    const app = defineApp({ name: "spread", resources: { ...billing, files: bucket({ id: "spread-files", access: "private" }) } });
    expectTypeOf(app.resources.invoices).toEqualTypeOf<QueueHandle<"invoices", typeof invoiceIssued>>();
  });
});

describe("composeResources", () => {
  it("merges groups declared in separate modules with their exact types", () => {
    const billing = defineResources({ invoices: queue({ id: "billing-invoices", message: invoiceIssued, schemaVersion: 1 }) });
    const storage = defineResources({ files: bucket({ id: "billing-files", access: "private" }) });
    const composed = composeResources(billing, storage);
    expectTypeOf(composed).toEqualTypeOf<ComposedResources<[typeof billing, typeof storage]>>();
    expectTypeOf(composed.invoices).toEqualTypeOf<QueueHandle<"billing-invoices", typeof invoiceIssued>>();
    expectTypeOf(composed.files.id).toEqualTypeOf<"billing-files">();
    expect(Object.keys(composed)).toEqual(["invoices", "files"]);
    expect(Object.isFrozen(composed)).toBe(true);
  });

  it("rejects an alias declared by two groups, which object spread would silently drop", () => {
    const first = defineResources({ files: bucket({ id: "first-files", access: "private" }) });
    const second = defineResources({ files: bucket({ id: "second-files", access: "private" }) });
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- `files` is declared by both groups.
      composeResources(first, second);
    };
    expect(typeof neverCalled).toBe("function");
    /** The same function without the compile-time check, as plain JavaScript would call it. */
    const unchecked = composeResources as (...groups: readonly ResourceRecord[]) => unknown;
    expect(thrownCodes(() => unchecked(first, second))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });

  it("accepts widened groups and keeps their record type instead of losing it", () => {
    const typed = defineResources({ files: bucket({ id: "typed-files", access: "private" }) });
    const widened: ResourceRecord = { other: bucket({ id: "widened-files", access: "private" }) };
    const mixed = composeResources(typed, widened);
    expectTypeOf(mixed.files).toEqualTypeOf<BucketHandle<"typed-files">>();
    const groups: ResourceRecord[] = [typed, widened];
    expectTypeOf(composeResources(...groups)).toEqualTypeOf<ResourceRecord>();
    expect(Object.keys(mixed)).toEqual(["files", "other"]);
  });

  it("lets defineApp detect identifiers duplicated across groups", () => {
    const first = defineResources({ a: bucket({ id: "shared-id", access: "private" }) });
    const second = defineResources({ b: bucket({ id: "shared-id", access: "private" }) });
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- both groups declare the identifier "shared-id".
      defineApp({ name: "groups", resources: composeResources(first, second) });
    };
    expect(typeof neverCalled).toBe("function");
    expect(thrownCodes(() => defineApp({ name: "groups", resources: composeResources(first, second) as never }))).toEqual(["HOLQA_RESOURCE_ID_DUPLICATE"]);
  });
});