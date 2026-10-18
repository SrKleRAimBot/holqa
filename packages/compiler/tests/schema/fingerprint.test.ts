import { contractOf } from "@test/support/contracts";
import {
  describe,
  expect,
  it
} from "bun:test";

import { fingerprintSchemaContract } from "@/schema/fingerprint";

const order = { type: "object", properties: { id: { type: "string" }, priority: { enum: ["normal", "urgent"] } }, required: ["id", "priority"] };
const reordered = { required: ["priority", "id"], properties: { priority: { enum: ["urgent", "normal"] }, id: { type: "string" } }, type: "object" };

describe("fingerprintSchemaContract", () => {
  it("is a sha256 digest", async () => {
    expect(await fingerprintSchemaContract(contractOf(order))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is identical for equivalent canonical schemas, whatever the declaration order", async () => {
    expect(await fingerprintSchemaContract(contractOf(order))).toBe(await fingerprintSchemaContract(contractOf(reordered)));
  });

  it("canonicalizes contracts that were built by hand", async () => {
    const handBuilt = { ...contractOf(order), input: { jsonSchema: reordered, runtimeOnly: [] } };
    expect(await fingerprintSchemaContract(handBuilt)).toBe(await fingerprintSchemaContract(contractOf(order)));
  });

  it("ignores the source library and fidelity", async () => {
    expect(await fingerprintSchemaContract(contractOf(order, { library: "zod@4.6.7" }))).toBe(await fingerprintSchemaContract(contractOf(order, { library: "valibot@1.5.0", fidelity: "unverified" })));
  });

  it("is pinned: the basis is canonical JSON of format, dialect, encoding and both sides (golden value)", async () => {
    expect(await fingerprintSchemaContract(contractOf({ type: "string" }))).toBe("sha256:9bcee339dd15dc7ac0c618a273d399d7ab7da8cb6ee7ca1f7cbdb404e7631481");
  });

  it("changes when the wire schema changes", async () => {
    const widened = { ...order, properties: { ...order.properties, note: { type: "string" } } };
    expect(await fingerprintSchemaContract(contractOf(widened))).not.toBe(await fingerprintSchemaContract(contractOf(order)));
  });

  it("covers runtime-only constraints by path and kind, not by wording", async () => {
    const plain = await fingerprintSchemaContract(contractOf(order));
    const refined = await fingerprintSchemaContract(contractOf(order, { runtimeOnly: [{ path: "$.id", kind: "refinement", detail: "one wording" }] }));
    const reworded = await fingerprintSchemaContract(contractOf(order, { runtimeOnly: [{ path: "$.id", kind: "refinement", detail: "another wording" }] }));
    expect(refined).not.toBe(plain);
    expect(reworded).toBe(refined);
  });

  it("covers whether the output side is representable", async () => {
    const opaque = { ...contractOf(order), output: { representable: false as const, problem: { path: "$.at", reason: "Date" } } };
    expect(await fingerprintSchemaContract(opaque)).not.toBe(await fingerprintSchemaContract(contractOf(order)));
  });
});