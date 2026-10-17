import type { StandardSchemaV1 } from "@holqa/experiment-model";

import {
  describe,
  expect,
  it
} from "bun:test";
import { z } from "zod";

import { createStandardJsonSchemaAdapter } from "@/standard-json-schema";

describe("createStandardJsonSchemaAdapter", () => {
  const adapter = createStandardJsonSchemaAdapter("zod");

  it("marks its library as unverified", () => {
    expect(adapter.library).toBe("zod (unverified)");
  });

  it("converts through ~standard.jsonSchema", () => {
    const result = adapter.convert(z.object({ id: z.string() }), "input");
    expect(result).toEqual({ ok: true, value: { jsonSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, runtimeOnly: [] } });
  });

  it("cannot see constructs the vendor drops silently, which is why it is unverified", () => {
    const result = adapter.convert(z.string().refine(value => value.length > 3), "input");
    expect(result).toEqual({ ok: true, value: { jsonSchema: { type: "string" }, runtimeOnly: [] } });
  });

  it("turns converter exceptions into failures", () => {
    const result = adapter.convert(z.date(), "input");
    expect(result.ok).toBe(false);
  });

  it("fails for schemas without a Standard JSON Schema converter", () => {
    const plain: StandardSchemaV1 = { "~standard": { version: 1, vendor: "handmade", validate: value => ({ value }) } };
    const result = createStandardJsonSchemaAdapter("handmade").convert(plain, "input");
    expect(result).toEqual({ ok: false, error: { reason: "$: Vendor \"handmade\" does not implement Standard JSON Schema." } });
  });
});