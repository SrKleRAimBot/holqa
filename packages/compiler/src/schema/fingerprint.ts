import type {
  JsonObject,
  RuntimeOnlyConstraint
} from "@holqa/core";

import type { SchemaContract } from "@/schema/schema-contract";

import { canonicalJsonStringify } from "@/manifest/canonical-json";
import { canonicalizeJsonSchema } from "@/schema/canonical-json-schema";

/** The prefix of every schema fingerprint, naming the hash algorithm. */
export const schemaFingerprintPrefix = "sha256:";

/**
 * Computes a contract's fingerprint: the SHA-256 of the canonical JSON of its
 * wire-relevant parts. Contracts whose canonical descriptions are equal have
 * equal fingerprints, whatever the property declaration order.
 *
 * Included: format, dialect, encoding, both sides' canonical JSON Schemas, the
 * representability of the output, and the path and kind of every runtime-only
 * constraint. Excluded: the source (vendor, library, fidelity), human-readable
 * details and reasons, and the declared schema version. Switching libraries
 * therefore keeps the fingerprint when the canonical descriptions agree.
 *
 * A changed fingerprint means the contract may have changed; use the
 * compatibility checker to learn whether the change is breaking.
 *
 * @param contract - The contract to fingerprint.
 * @returns `sha256:` followed by 64 lowercase hex digits.
 * @throws {CanonicalJsonError} When the contract contains values without a canonical JSON form.
 */
export async function fingerprintSchemaContract(contract: SchemaContract): Promise<string> {
  const basis = {
    format: contract.format,
    dialect: contract.dialect,
    encoding: contract.encoding,
    input: sideBasis(contract.input.jsonSchema, contract.input.runtimeOnly),
    output: contract.output.representable
      ? { representable: true, ...sideBasis(contract.output.jsonSchema, contract.output.runtimeOnly) }
      : { representable: false }
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJsonStringify(basis)));
  return `${schemaFingerprintPrefix}${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Reduces one side to its fingerprinted parts: the canonical JSON Schema and
 * the sorted, de-duplicated `path` and `kind` of its runtime-only constraints.
 *
 * @param jsonSchema - The side's JSON Schema, canonicalized before hashing.
 * @param runtimeOnly - The side's runtime-only constraints.
 * @returns The fingerprint basis for the side.
 */
function sideBasis(jsonSchema: JsonObject, runtimeOnly: readonly RuntimeOnlyConstraint[]): { jsonSchema: JsonObject; runtimeOnly: string[] } {
  return {
    jsonSchema: canonicalizeJsonSchema(jsonSchema),
    runtimeOnly: [...new Set(runtimeOnly.map(constraint => `${constraint.kind} ${constraint.path}`))].sort()
  };
}