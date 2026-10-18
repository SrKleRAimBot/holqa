import type { SchemaContractRecord } from "@holqa/compiler";
import type { StandardSchemaV1 } from "@holqa/core";

import {
  checkSchemaCompatibility,
  describeSchemaContract,
  normalizeSchema
} from "@holqa/compiler";
import { zodAdapter } from "@holqa/zod";
import {
  describe,
  expect,
  it
} from "bun:test";
import { z } from "zod";
import * as zm from "zod/mini";

import {
  orderPlacedV1,
  orderPlacedV1Reordered,
  orderPlacedV1WithNote,
  orderPlacedWithCustomer,
  orderPlacedWithDate,
  orderPlacedWithoutUrgent
} from "@/src/orders";

const subject = "message for queue \"order-placed\"";

/**
 * Describes a Zod schema as a contract record.
 *
 * @param schema - The message schema.
 * @param schemaVersion - The declared version.
 * @returns The fingerprinted record.
 * @throws {Error} When the schema cannot be described.
 */
async function recordOf(schema: StandardSchemaV1, schemaVersion = 1): Promise<SchemaContractRecord> {
  const result = await describeSchemaContract(schema, { subject, schemaVersion, adapters: [zodAdapter] });
  if (!result.ok)
    throw new Error(result.error.map(diagnostic => diagnostic.message).join("\n"));
  return result.value.record;
}

describe("canonical contracts and fingerprints", () => {
  it("give semantically identical schemas identical fingerprints, whatever the declaration order", async () => {
    expect((await recordOf(orderPlacedV1Reordered)).fingerprint).toBe((await recordOf(orderPlacedV1)).fingerprint);
  });

  it("give Zod classic and Zod Mini schemas with the same contract the same fingerprint", async () => {
    const classic = z.object({ id: z.string(), tags: z.array(z.string()).optional() });
    const mini = zm.object({ tags: zm.optional(zm.array(zm.string())), id: zm.string() });
    expect((await recordOf(mini)).fingerprint).toBe((await recordOf(classic)).fingerprint);
  });

  it("give a changed contract a different fingerprint", async () => {
    expect((await recordOf(orderPlacedV1WithNote)).fingerprint).not.toBe((await recordOf(orderPlacedV1)).fingerprint);
  });

  it("describe the wire side of a transformed schema and record that its decoded side is not portable", async () => {
    const { contract } = await recordOf(orderPlacedV1);
    expect(contract.source).toEqual({ vendor: "zod", library: zodAdapter.library, fidelity: "verified" });
    expect(contract.input.jsonSchema).toMatchObject({ properties: { placedAt: { type: "string", format: "date-time" } } });
    expect(contract.output).toMatchObject({ representable: false, problem: { path: "$.placedAt" } });
  });
});

describe("unsupported constructs", () => {
  it("fail with HOLQA_SCHEMA_UNSUPPORTED naming the field and a portable alternative", () => {
    const result = normalizeSchema(orderPlacedWithDate, { subject, adapters: [zodAdapter] });
    expect(result.ok).toBe(false);
    if (result.ok)
      return;
    expect(result.error).toEqual([expect.objectContaining({
      code: "HOLQA_SCHEMA_UNSUPPORTED",
      severity: "error",
      hint: expect.stringContaining("z.iso.datetime()"),
      details: { subject, path: "$.placedAt" }
    })]);
  });

  it("warn about refinements that the portable description cannot carry", () => {
    const result = normalizeSchema(z.object({ sku: z.string().refine(value => value.startsWith("SKU-")) }), { subject, adapters: [zodAdapter] });
    expect(result.ok && result.value.diagnostics).toEqual([expect.objectContaining({ code: "HOLQA_SCHEMA_RUNTIME_ONLY", severity: "warning", details: expect.objectContaining({ path: "$.sku", kind: "refinement" }) })]);
  });
});

describe("message contract evolution", () => {
  it("accepts a compatible change without a new version", async () => {
    const report = checkSchemaCompatibility(await recordOf(orderPlacedV1), await recordOf(orderPlacedV1WithNote), { role: "message", subject });
    expect(report).toMatchObject({ classification: "safe", compatible: true, diagnostics: [] });
  });

  it("rejects a new required field before it can strand messages already in the queue", async () => {
    const report = checkSchemaCompatibility(await recordOf(orderPlacedV1), await recordOf(orderPlacedWithCustomer), { role: "message", subject });
    expect(report.compatible).toBe(false);
    expect(report.diagnostics).toEqual([expect.objectContaining({ code: "HOLQA_SCHEMA_CHANGE_BREAKING", details: expect.objectContaining({ path: "$.customerId", kind: "required-property-added" }) })]);
  });

  it("rejects a removed enum value", async () => {
    const report = checkSchemaCompatibility(await recordOf(orderPlacedV1), await recordOf(orderPlacedWithoutUrgent), { role: "message", subject });
    expect(report.changes).toContainEqual(expect.objectContaining({ path: "$.priority", kind: "enum-value-removed", classification: "breaking" }));
    expect(report.compatible).toBe(false);
  });

  it("turns the same change into a migration warning once the schema version is increased", async () => {
    const report = checkSchemaCompatibility(await recordOf(orderPlacedV1, 1), await recordOf(orderPlacedWithCustomer, 2), { role: "message", subject });
    expect(report.compatible).toBe(true);
    expect(report.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_SCHEMA_MIGRATION_REQUIRED"]);
  });
});