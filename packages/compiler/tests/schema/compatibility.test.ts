import type { JsonObject } from "@holqa/core";

import type {
  ChangeClassification,
  ContractRole,
  SchemaCompatibilityReport
} from "@/schema/compatibility";

import { recordOf } from "@test/support/contracts";
import {
  describe,
  expect,
  it
} from "bun:test";

import { checkSchemaCompatibility } from "@/schema/compatibility";

const subject = "message for queue \"orders\"";

/** The properties of version 1 of an order message. */
const orderProperties: JsonObject = { orderId: { type: "string" }, priority: { type: "string", enum: ["normal", "urgent"] } };

/** Version 1 of an order message. */
const orderV1: JsonObject = { type: "object", properties: orderProperties, required: ["orderId", "priority"] };

/**
 * Compares two JSON Schemas as contract records.
 *
 * @param previous - The deployed schema.
 * @param next - The candidate schema.
 * @param role - The contract's role.
 * @param versions - The previous and next schema versions.
 * @returns The report.
 */
async function compare(previous: JsonObject, next: JsonObject, role: ContractRole = "message", versions: [number, number] = [1, 1]): Promise<SchemaCompatibilityReport> {
  return checkSchemaCompatibility(await recordOf(previous, versions[0]), await recordOf(next, versions[1]), { role, subject });
}

/**
 * Returns the codes of a report's diagnostics.
 *
 * @param report - A compatibility report.
 * @returns The codes, in order.
 */
function codes(report: SchemaCompatibilityReport): string[] {
  return report.diagnostics.map(diagnostic => diagnostic.code);
}

describe("checkSchemaCompatibility", () => {
  it("reports no changes for identical fingerprints", async () => {
    const report = await compare(orderV1, { ...orderV1, required: ["priority", "orderId"] });
    expect(report).toMatchObject({ classification: "safe", compatible: true, changes: [], diagnostics: [] });
    expect(report.previous.fingerprint).toBe(report.next.fingerprint);
  });

  it("treats annotation-only changes as safe", async () => {
    const report = await compare(orderV1, { ...orderV1, description: "An order." });
    expect(report.previous.fingerprint).not.toBe(report.next.fingerprint);
    expect(report).toMatchObject({ classification: "safe", compatible: true, changes: [] });
  });

  it("detects a required field added to a queue message before it can reject queued messages", async () => {
    const next = { ...orderV1, properties: { ...orderProperties, customerId: { type: "string" } }, required: ["orderId", "priority", "customerId"] };
    const report = await compare(orderV1, next);
    expect(report.compatible).toBe(false);
    expect(report.classification).toBe("breaking");
    expect(report.changes).toEqual([expect.objectContaining({ path: "$.customerId", kind: "required-property-added", direction: "backward", classification: "breaking" })]);
    expect(codes(report)).toEqual(["HOLQA_SCHEMA_CHANGE_BREAKING"]);
    expect(report.diagnostics[0]).toMatchObject({ severity: "error", details: { path: "$.customerId", kind: "required-property-added", previousVersion: 1, nextVersion: 1 } });
  });

  it("asks for a migration instead of failing when the schema version was increased", async () => {
    const next = { ...orderV1, required: ["orderId", "priority", "customerId"], properties: { ...orderProperties, customerId: { type: "string" } } };
    const report = await compare(orderV1, next, "message", [1, 2]);
    expect(report.compatible).toBe(true);
    expect(report.classification).toBe("breaking");
    expect(codes(report)).toEqual(["HOLQA_SCHEMA_MIGRATION_REQUIRED"]);
    expect(report.diagnostics[0]!.severity).toBe("warning");
    expect(report).toMatchObject({ previous: { schemaVersion: 1 }, next: { schemaVersion: 2 } });
  });

  it("classifies an added optional field on a queue as potentially breaking only for old consumers during a rollout", async () => {
    const strictV1 = { ...orderV1, additionalProperties: false };
    const next = { ...strictV1, properties: { ...orderProperties, note: { type: "string" } } };
    const report = await compare(strictV1, next);
    expect(report.changes).toEqual([expect.objectContaining({ path: "$.note", kind: "property-added", direction: "forward", classification: "potentially-breaking" })]);
    expect(codes(report)).toEqual(["HOLQA_SCHEMA_CHANGE_POTENTIALLY_BREAKING"]);
    expect(report.compatible).toBe(true);
  });

  it("treats an added optional field as safe for consumers that ignore undeclared fields", async () => {
    const next = { ...orderV1, properties: { ...orderProperties, note: { type: "string" } } };
    expect(await compare(orderV1, next)).toMatchObject({ classification: "safe", changes: [] });
  });

  it("names both sides of a changed constraint", async () => {
    const previous = { type: "object", properties: { quantity: { type: "integer", minimum: 1 } } };
    const next = { type: "object", properties: { quantity: { type: "integer", minimum: 5 } } };
    const report = await compare(previous, next);
    expect(report.changes).toEqual([{
      path: "$.quantity",
      kind: "constraint-tightened",
      direction: "backward",
      certainty: "definite",
      classification: "breaking",
      previous: ">= 1",
      next: ">= 5",
      message: "At $.quantity, a constraint was tightened (previous: >= 1; next: >= 5)."
    }]);

    const relaxed = await compare(next, previous);
    expect(relaxed.changes).toEqual([expect.objectContaining({ kind: "constraint-relaxed", direction: "forward", previous: ">= 5", next: ">= 1", classification: "potentially-breaking" })]);
  });

  describe("roles", () => {
    const widened = { ...orderV1, properties: { ...orderProperties, priority: { type: "string", enum: ["low", "normal", "urgent"] } } };

    it.each<[ContractRole, ChangeClassification, string]>([
      ["message", "potentially-breaking", "HOLQA_SCHEMA_CHANGE_POTENTIALLY_BREAKING"],
      ["request", "safe", ""],
      ["response", "breaking", "HOLQA_SCHEMA_CHANGE_BREAKING"]
    ])("classifies an added enum value for a %s as %s", async (role, classification, code) => {
      const report = await compare(orderV1, widened, role);
      expect(report.classification).toBe(classification);
      expect(codes(report)).toEqual(code === "" ? [] : [code]);
      expect(report.changes.map(change => change.kind)).toEqual(["enum-value-added"]);
    });

    it.each<[ContractRole, ChangeClassification]>([
      ["message", "breaking"],
      ["request", "breaking"],
      ["response", "safe"]
    ])("classifies a removed enum value for a %s as %s", async (role, classification) => {
      const report = await compare(widened, orderV1, role);
      expect(report.classification).toBe(classification);
      expect(report.changes.map(change => change.kind)).toEqual(["enum-value-removed"]);
    });
  });

  it("downgrades uncertain findings to potentially breaking", async () => {
    const previous = { type: "object", properties: { sku: { type: "string", pattern: "^A" } } };
    const next = { type: "object", properties: { sku: { type: "string", pattern: "^B" } } };
    const report = await compare(previous, next, "request");
    expect(report.classification).toBe("potentially-breaking");
    expect(report.compatible).toBe(true);
  });

  it("reports unanalyzable changes as unverifiable", async () => {
    const report = await compare({ allOf: [{ type: "string" }] }, { allOf: [{ type: "string", minLength: 2 }] });
    expect(report.classification).toBe("unverifiable");
    expect(codes(report)).toContain("HOLQA_SCHEMA_CHANGE_UNVERIFIABLE");
  });

  it("reports added and removed runtime-only constraints", async () => {
    const constraint = { path: "$.orderId", kind: "refinement" as const, detail: "custom refinement" };
    const plain = await recordOf(orderV1);
    const refined = await recordOf(orderV1, 1, { runtimeOnly: [constraint] });
    const added = checkSchemaCompatibility(plain, refined, { role: "message", subject });
    expect(added.changes).toEqual([expect.objectContaining({ kind: "runtime-constraint-added", path: "$.orderId", classification: "potentially-breaking" })]);
    const removed = checkSchemaCompatibility(refined, plain, { role: "request", subject });
    expect(removed.changes).toEqual([expect.objectContaining({ kind: "runtime-constraint-removed", classification: "safe" })]);
  });

  it("marks comparisons involving unverified contracts as unverifiable", async () => {
    const report = checkSchemaCompatibility(await recordOf(orderV1), await recordOf({ ...orderV1, title: "x" }, 1, { fidelity: "unverified" }), { role: "message", subject });
    expect(report.changes.map(change => change.kind)).toEqual(["fidelity-unverified"]);
    expect(report.classification).toBe("unverifiable");
  });

  it.each<ContractRole>(["message", "request", "response"])("marks unverified contracts as unverifiable for a %s", async (role) => {
    const report = checkSchemaCompatibility(await recordOf(orderV1), await recordOf({ ...orderV1, title: "x" }, 1, { fidelity: "unverified" }), { role, subject });
    expect(report.classification).toBe("unverifiable");
    expect(report.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_SCHEMA_CHANGE_UNVERIFIABLE"]);
  });

  it("treats a changed contract format as breaking, even for responses", async () => {
    const previous = await recordOf(orderV1);
    const next = { ...previous, fingerprint: "sha256:other", contract: { ...previous.contract, format: "holqa.schema-contract/2" as never } };
    const report = checkSchemaCompatibility(previous, next, { role: "response", subject });
    expect(report.changes.map(change => [change.kind, change.classification])).toEqual([["contract-format-changed", "breaking"]]);
    expect(report.compatible).toBe(false);
  });

  it("rejects a decreased schema version", async () => {
    const report = await compare(orderV1, orderV1, "message", [2, 1]);
    expect(codes(report)).toEqual(["HOLQA_SCHEMA_VERSION_INVALID"]);
    expect(report.compatible).toBe(false);
  });

  it("produces a JSON-serializable report for migration tooling", async () => {
    const report = await compare(orderV1, { ...orderV1, required: ["orderId"] });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe("the evolution guidance in docs/reference/schema-contracts.md", () => {
  /**
   * Builds an object schema.
   *
   * @param properties - The declared properties.
   * @param required - The required property names.
   * @param strict - Whether undeclared properties are rejected.
   * @returns The JSON Schema.
   */
  function object(properties: JsonObject, required: string[], strict = false): JsonObject {
    return { type: "object", properties, required, ...(strict ? { additionalProperties: false } : {}) };
  }
  const id = { type: "string" };
  const note = { type: "string" };
  const refined = [{ path: "$.id", kind: "refinement" as const, detail: "custom refinement" }];

  it.each<[string, JsonObject, JsonObject, [ChangeClassification, ChangeClassification, ChangeClassification]]>([
    ["add an optional property", object({ id }, ["id"]), object({ id, note }, ["id"]), ["safe", "safe", "safe"]],
    ["add an optional property to strict schemas", object({ id }, ["id"], true), object({ id, note }, ["id"], true), ["potentially-breaking", "safe", "breaking"]],
    ["add a required property", object({ id }, ["id"]), object({ id, note }, ["id", "note"]), ["breaking", "breaking", "safe"]],
    ["make a required property optional", object({ id, note }, ["id", "note"]), object({ id, note }, ["id"]), ["potentially-breaking", "safe", "breaking"]],
    ["remove an optional property", object({ id, note }, ["id"]), object({ id }, ["id"]), ["safe", "safe", "safe"]],
    ["remove an optional property from strict schemas", object({ id, note }, ["id"], true), object({ id }, ["id"], true), ["breaking", "breaking", "safe"]],
    ["remove a required property", object({ id, note }, ["id", "note"]), object({ id }, ["id"]), ["potentially-breaking", "safe", "breaking"]],
    ["add an enum value", object({ id: { enum: ["a"] } }, ["id"]), object({ id: { enum: ["a", "b"] } }, ["id"]), ["potentially-breaking", "safe", "breaking"]],
    ["remove an enum value", object({ id: { enum: ["a", "b"] } }, ["id"]), object({ id: { enum: ["a"] } }, ["id"]), ["breaking", "breaking", "safe"]],
    ["tighten a constraint", object({ id }, ["id"]), object({ id: { type: "string", maxLength: 5 } }, ["id"]), ["breaking", "breaking", "safe"]],
    ["relax a constraint", object({ id: { type: "string", maxLength: 5 } }, ["id"]), object({ id }, ["id"]), ["potentially-breaking", "safe", "breaking"]],
    ["change a type", object({ id }, ["id"]), object({ id: { type: "number" } }, ["id"]), ["breaking", "breaking", "breaking"]]
  ])("%s", async (_name, previous, next, [message, request, response]) => {
    expect((await compare(previous, next, "message")).classification).toBe(message);
    expect((await compare(previous, next, "request")).classification).toBe(request);
    expect((await compare(previous, next, "response")).classification).toBe(response);
  });

  it("add a refinement", async () => {
    const before = await recordOf(object({ id }, ["id"]));
    const after = await recordOf(object({ id }, ["id"]), 1, { runtimeOnly: refined });
    expect((["message", "request", "response"] as const).map(role => checkSchemaCompatibility(before, after, { role, subject }).classification)).toEqual(["potentially-breaking", "potentially-breaking", "safe"]);
  });
});