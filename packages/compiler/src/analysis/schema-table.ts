import type {
  Diagnostic,
  DiagnosticLocation,
  SchemaAdapter,
  StandardSchemaV1
} from "@holqa/core";

import type {
  ManifestSchema,
  ManifestSchemaReference
} from "@/manifest/manifest";
import type { SchemaContract } from "@/schema/schema-contract";

import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

import { compareCodeUnits } from "@/discovery/module-path";
import { canonicalJsonStringify } from "@/manifest/canonical-json";
import { fingerprintSchemaContract } from "@/schema/fingerprint";
import { normalizeSchema } from "@/schema/normalize-schema";

/** A described schema: its canonical contract and fingerprint. */
interface DescribedSchema {
  readonly contract: SchemaContract;
  readonly fingerprint: string;
}

/** What one use of a schema is, for diagnostics and wire-side checks. */
export interface SchemaUse {
  /** What the schema describes, for example `message of queue "orders"`. */
  readonly subject: string;
  /** The role, for example `message` or `response.200`. Response roles travel on the wire in their output form. */
  readonly role: string;
  readonly location: DiagnosticLocation;
  /** The declared contract version, when the declaration has one. */
  readonly schemaVersion?: number;
}

/**
 * Normalizes every schema of an application once, keyed by schema object, and
 * collects the normalized contracts into the manifest's schema table keyed by
 * fingerprint. A schema used by both a queue and its consumer is described
 * once and reported once.
 */
export class SchemaTable {
  /** Normalization results by schema object; `undefined` marks a schema that could not be described. */
  private readonly described = new Map<StandardSchemaV1, Promise<DescribedSchema | undefined>>();
  /** Table entries by fingerprint, with their canonical text for deterministic tie-breaking. */
  private readonly entries = new Map<string, { readonly text: string; readonly entry: ManifestSchema }>();

  /**
   * Creates a table that describes schemas with the given adapters.
   *
   * @param adapters - Schema-library adapters, matched by vendor.
   * @param report - Receives every diagnostic produced while describing schemas.
   */
  constructor(private readonly adapters: readonly SchemaAdapter[], private readonly report: (diagnostic: Diagnostic) => void) {}

  /**
   * Describes a schema (once per schema object), checks its wire side for the
   * given use, adds it to the table and returns a reference to it.
   *
   * @param schema - A Standard Schema from a resource, handler or configuration entry.
   * @param use - The subject, role, location and optional version of this use.
   * @returns The reference, or `undefined` when the schema cannot be used as a contract (an error was reported).
   */
  async reference(schema: StandardSchemaV1, use: SchemaUse): Promise<ManifestSchemaReference | undefined> {
    let pending = this.described.get(schema);
    if (pending === undefined) {
      pending = this.describe(schema, use);
      this.described.set(schema, pending);
    }
    const described = await pending;
    if (described === undefined)
      return undefined;
    const { contract, fingerprint } = described;
    if (use.role.startsWith("response.") && !contract.output.representable) {
      this.report(createDiagnostic({
        code: diagnosticCodes.schemaUnsupported,
        severity: "error",
        message: `The ${use.subject} is sent in its output form, which has no portable description at ${contract.output.problem.path}: ${contract.output.problem.reason}`,
        location: use.location,
        hint: "Response bodies are serialized after validation. Make the schema's output JSON-compatible.",
        details: { subject: use.subject, path: contract.output.problem.path }
      }));
      return undefined;
    }
    const { source, ...entry } = contract;
    const text = canonicalJsonStringify(entry);
    const existing = this.entries.get(fingerprint);
    // Equal fingerprints mean equal wire-relevant content; descriptive text may still
    // differ between libraries. Keep the smallest canonical text so the choice is deterministic.
    if (existing === undefined || compareCodeUnits(text, existing.text) < 0)
      this.entries.set(fingerprint, { text, entry });
    return { fingerprint, source, ...(use.schemaVersion === undefined ? {} : { schemaVersion: use.schemaVersion }) };
  }

  /**
   * Returns the table, keyed by fingerprint.
   *
   * @returns A new object with one entry per distinct fingerprint, in fingerprint order.
   */
  table(): Record<string, ManifestSchema> {
    return Object.fromEntries([...this.entries.keys()].sort(compareCodeUnits).map(fingerprint => [fingerprint, this.entries.get(fingerprint)!.entry]));
  }

  /**
   * Normalizes and fingerprints a schema, reporting its diagnostics at the use's location.
   *
   * @param schema - A Standard Schema from a resource, handler or configuration entry.
   * @param use - The first use, which names the schema in diagnostics.
   * @returns The described schema, or `undefined` after reporting errors.
   */
  private async describe(schema: StandardSchemaV1, use: SchemaUse): Promise<DescribedSchema | undefined> {
    const normalized = normalizeSchema(schema, { subject: use.subject, adapters: this.adapters });
    if (!normalized.ok) {
      for (const diagnostic of normalized.error)
        this.report(createDiagnostic({ ...diagnostic, location: use.location }));
      return undefined;
    }
    for (const diagnostic of normalized.value.diagnostics)
      this.report(createDiagnostic({ ...diagnostic, location: use.location }));
    const { contract } = normalized.value;
    return { contract, fingerprint: await fingerprintSchemaContract(contract) };
  }
}