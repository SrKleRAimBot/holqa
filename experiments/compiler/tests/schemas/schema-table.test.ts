import type { CompilerDiagnostic } from "@/diagnostics";

import { experimentCodes } from "@holqa/experiment-model";
import { zodAdapter } from "@holqa/experiment-schema-adapters";
import {
  describe,
  expect,
  it
} from "bun:test";
import { z } from "zod";

import { SchemaTable } from "@/schemas/schema-table";

import { fakeSchema } from "../support/schemas";

/**
 * Creates a schema table with the Zod adapter and an inspectable diagnostic list.
 *
 * @returns The table and the list it reports into.
 */
function createTable(): { table: SchemaTable; diagnostics: CompilerDiagnostic[] } {
  const diagnostics: CompilerDiagnostic[] = [];
  return { table: new SchemaTable([zodAdapter], diagnostics), diagnostics };
}

describe("schemaTable", () => {
  it("gives equal schemas with different property order the same fingerprint", async () => {
    const { table, diagnostics } = createTable();
    const first = await table.use(z.object({ a: z.string(), b: z.number() }), "first", "input");
    const second = await table.use(z.object({ b: z.number(), a: z.string() }), "second", "input");
    expect(second.input).toBe(first.input!);
    expect(diagnostics).toEqual([]);
    expect(table.entries.size).toBeGreaterThan(0);
  });

  it("gives a changed field a different fingerprint", async () => {
    const { table } = createTable();
    const first = await table.use(z.object({ a: z.string() }), "first", "input");
    const second = await table.use(z.object({ a: z.string().min(1) }), "second", "input");
    expect(second.input).not.toBe(first.input);
  });

  it("converts and diagnoses a schema object once, however often it is used", async () => {
    const { table, diagnostics } = createTable();
    const schema = fakeSchema("other", { input: { type: "string" }, output: { type: "string" } });
    const first = await table.use(schema, "resource", "input");
    const second = await table.use(schema, "handler", "input");
    expect(second).toEqual(first);
    expect(diagnostics.filter(diagnostic => diagnostic.code === experimentCodes.schemaFidelityUnverified)).toHaveLength(1);
  });

  it("warns when only the generic Standard JSON Schema converter is available", async () => {
    const { table, diagnostics } = createTable();
    const use = await table.use(fakeSchema("other", { input: { type: "string" }, output: { type: "string" } }), "subject", "input");
    expect(use.fidelity).toBe("unverified");
    expect(use.converter).toBe("standard-json-schema (other)");
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity])).toEqual([[experimentCodes.schemaFidelityUnverified, "warning"]]);
  });

  it("rejects a schema with neither an adapter nor a converter", async () => {
    const { table, diagnostics } = createTable();
    const use = await table.use(fakeSchema("other"), "subject", "input");
    expect(use).toEqual({ input: null, output: null, converter: "none (other)", fidelity: "unverified" });
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity])).toEqual([[experimentCodes.schemaUnsupported, "error"]]);
  });

  it("treats a failure on the wire side as an error and on the other side as a warning", async () => {
    const schema = fakeSchema("other", { input: { type: "string" }, output: "throw" });
    const asInput = createTable();
    const use = await asInput.table.use(schema, "subject", "input");
    expect(use.input).not.toBeNull();
    expect(use.output).toBeNull();
    expect(asInput.diagnostics.filter(diagnostic => diagnostic.code === experimentCodes.schemaUnsupported).map(diagnostic => diagnostic.severity)).toEqual(["warning"]);

    const asOutput = createTable();
    await asOutput.table.use(schema, "subject", "output");
    expect(asOutput.diagnostics.filter(diagnostic => diagnostic.code === experimentCodes.schemaUnsupported).map(diagnostic => diagnostic.severity)).toEqual(["error"]);
  });

  it("rejects converter output that is not plain JSON", async () => {
    const { table, diagnostics } = createTable();
    const schema = fakeSchema("other", { input: { type: "string" }, output: { type: "string" } });
    (schema["~standard"] as unknown as { jsonSchema: { input: () => unknown } }).jsonSchema.input = () => ({ default: Number.NaN });
    const use = await table.use(schema, "subject", "input");
    expect(use.input).toBeNull();
    expect(diagnostics.some(diagnostic => diagnostic.code === experimentCodes.schemaUnsupported && diagnostic.severity === "error")).toBe(true);
  });

  it("records runtime-only constraints from the Zod adapter and keeps them in the fingerprint", async () => {
    const { table, diagnostics } = createTable();
    const plain = await table.use(z.string(), "plain", "input");
    const refined = await table.use(z.string().refine(value => value.startsWith("order-")), "refined", "input");
    expect(refined.input).not.toBe(plain.input);
    expect(table.entries.get(refined.input!)?.runtimeOnly.length).toBeGreaterThan(0);
    expect(diagnostics.some(diagnostic => diagnostic.code === experimentCodes.schemaUnsupported && diagnostic.severity === "warning")).toBe(true);
  });

  it("represents only the input side of a Zod transform", async () => {
    const { table } = createTable();
    const use = await table.use(z.string().transform(value => value.length), "transformed", "input");
    expect(use.input).not.toBeNull();
    expect(use.output).toBeNull();
  });
});