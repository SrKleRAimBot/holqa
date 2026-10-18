import type { Diagnostic } from "@holqa/core";

import {
  err,
  ok
} from "@holqa/core";
import {
  fakeAdapter,
  fakeSchema
} from "@test/support/contracts";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  describeSchemaContract,
  normalizeSchema
} from "@/schema/normalize-schema";

const subject = "message for queue \"orders\"";

/**
 * Returns the codes of a list of diagnostics.
 *
 * @param diagnostics - Diagnostics returned by the code under test.
 * @returns Their codes, in order.
 */
function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map(diagnostic => diagnostic.code);
}

describe("normalizeSchema with a vendor adapter", () => {
  it("produces a verified, canonical contract", () => {
    const adapter = fakeAdapter(() => ok({ jsonSchema: { $schema: "x", type: "object", required: ["b", "a"] }, runtimeOnly: [] }));
    const result = normalizeSchema(fakeSchema(), { subject, adapters: [adapter] });
    expect(result.ok).toBe(true);
    if (!result.ok)
      return;
    expect(result.value.diagnostics).toEqual([]);
    expect(result.value.contract).toEqual({
      format: "holqa.schema-contract/1",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      encoding: "json",
      source: { vendor: "test", library: "test@1", fidelity: "verified" },
      input: { jsonSchema: { type: "object", required: ["a", "b"] }, runtimeOnly: [] },
      output: { representable: true, jsonSchema: { type: "object", required: ["a", "b"] }, runtimeOnly: [] }
    });
  });

  it("warns once per runtime-only constraint on the wire side", () => {
    const adapter = fakeAdapter(() => ok({ jsonSchema: { type: "string" }, runtimeOnly: [{ path: "$.sku", kind: "refinement", detail: "custom refinement" }] }));
    const result = normalizeSchema(fakeSchema(), { subject, adapters: [adapter] });
    if (!result.ok)
      throw new Error("expected success");
    expect(codes(result.value.diagnostics)).toEqual(["HOLQA_SCHEMA_RUNTIME_ONLY"]);
    expect(result.value.diagnostics[0]).toMatchObject({ severity: "warning", details: { subject, path: "$.sku", kind: "refinement" } });
  });

  it("records an unrepresentable output side without failing", () => {
    const adapter = fakeAdapter((_schema, side) => side === "input"
      ? ok({ jsonSchema: { type: "string", format: "date-time" }, runtimeOnly: [] })
      : err({ path: "$", reason: "Date objects are not JSON data." }));
    const result = normalizeSchema(fakeSchema(), { subject, adapters: [adapter] });
    if (!result.ok)
      throw new Error("expected success");
    expect(result.value.contract.output).toEqual({ representable: false, problem: { path: "$", reason: "Date objects are not JSON data." } });
  });

  it("rejects a schema whose wire side cannot be described", () => {
    const adapter = fakeAdapter(() => err({ path: "$.placedAt", reason: "Date objects are not JSON data.", hint: "Use an ISO string." }));
    const result = normalizeSchema(fakeSchema(), { subject, adapters: [adapter] });
    expect(result).toEqual({ ok: false, error: [expect.objectContaining({ code: "HOLQA_SCHEMA_UNSUPPORTED", severity: "error", hint: "Use an ISO string.", details: { subject, path: "$.placedAt" } })] });
  });

  it("reports adapters that throw instead of hiding the failure", () => {
    const adapter = fakeAdapter(() => {
      throw new Error("boom");
    });
    const result = normalizeSchema(fakeSchema(), { subject, adapters: [adapter] });
    expect(!result.ok && result.error[0]!.message).toContain("boom");
  });

  it("rejects adapter output that is not plain JSON", () => {
    const adapter = fakeAdapter(() => ok({ jsonSchema: { pattern: Number.NaN } as never, runtimeOnly: [] }));
    const result = normalizeSchema(fakeSchema(), { subject, adapters: [adapter] });
    expect(!result.ok && codes(result.error)).toEqual(["HOLQA_SCHEMA_UNSUPPORTED"]);
  });
});

describe("normalizeSchema without a vendor adapter", () => {
  it("describes Standard JSON Schema implementations as unverified, with a warning", () => {
    const result = normalizeSchema(fakeSchema("other", { $schema: "x", type: "number" }), { subject, adapters: [fakeAdapter()] });
    if (!result.ok)
      throw new Error("expected success");
    expect(result.value.contract.source).toEqual({ vendor: "other", library: "other (Standard JSON Schema)", fidelity: "unverified" });
    expect(result.value.contract.input.jsonSchema).toEqual({ type: "number" });
    expect(codes(result.value.diagnostics)).toEqual(["HOLQA_SCHEMA_FIDELITY_UNVERIFIED"]);
  });

  it("turns converter exceptions into HOLQA_SCHEMA_UNSUPPORTED", () => {
    const schema = fakeSchema("other", {});
    const props = schema["~standard"] as unknown as { jsonSchema: { input: () => never } };
    props.jsonSchema.input = () => {
      throw new Error("Transforms cannot be represented in JSON Schema");
    };
    const result = normalizeSchema(schema, { subject });
    expect(!result.ok && result.error[0]!.message).toContain("Transforms cannot be represented");
  });

  it("rejects vendors with neither an adapter nor Standard JSON Schema", () => {
    const result = normalizeSchema(fakeSchema("other"), { subject });
    expect(!result.ok && codes(result.error)).toEqual(["HOLQA_SCHEMA_UNSUPPORTED"]);
  });

  it.each([null, "z.string()", {}, { "~standard": { version: 2 } }])("rejects %p, which is not a Standard Schema", (value) => {
    const result = normalizeSchema(value, { subject });
    expect(!result.ok && codes(result.error)).toEqual(["HOLQA_SCHEMA_UNSUPPORTED"]);
  });
});

describe("describeSchemaContract", () => {
  it("adds the declared version and the fingerprint", async () => {
    const result = await describeSchemaContract(fakeSchema(), { subject, schemaVersion: 3, adapters: [fakeAdapter()] });
    if (!result.ok)
      throw new Error("expected success");
    expect(result.value.record.schemaVersion).toBe(3);
    expect(result.value.record.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([0, 1.5, -2])("rejects schema version %p", async (schemaVersion) => {
    const result = await describeSchemaContract(fakeSchema(), { subject, schemaVersion, adapters: [fakeAdapter()] });
    expect(!result.ok && codes(result.error)).toEqual(["HOLQA_SCHEMA_VERSION_INVALID"]);
  });

  it("passes normalization errors through", async () => {
    const result = await describeSchemaContract(fakeSchema("other"), { subject, schemaVersion: 1 });
    expect(!result.ok && codes(result.error)).toEqual(["HOLQA_SCHEMA_UNSUPPORTED"]);
  });
});