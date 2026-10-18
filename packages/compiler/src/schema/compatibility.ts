import type {
  Diagnostic,
  JsonObject,
  RuntimeOnlyConstraint
} from "@holqa/core";

import type {
  AcceptanceCertainty,
  AcceptanceFinding
} from "@/schema/json-schema-acceptance";
import type { SchemaContractRecord } from "@/schema/schema-contract";

import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

import { canonicalizeJsonSchema } from "@/schema/canonical-json-schema";
import { findRejections } from "@/schema/json-schema-acceptance";

/**
 * What a schema contract is used for, which decides who reads data written
 * under the other version:
 *
 * - `message`: queue messages. New consumers read messages that old producers
 *   wrote (and that may sit in the queue for days); old consumers may read new
 *   messages during a rolling deployment.
 * - `request`: public API requests. New servers read requests from old clients.
 * - `response`: public API responses. Old clients read responses from new servers.
 */
export type ContractRole = "message" | "request" | "response";

/**
 * How a change affects existing data and deployments, from least to most severe.
 *
 * - `safe`: every reader keeps accepting what it accepted before.
 * - `potentially-breaking`: some data may be rejected, or only during a rolling deployment.
 * - `unverifiable`: the checker cannot analyze the change.
 * - `breaking`: data that was valid is rejected.
 */
export type ChangeClassification = "safe" | "potentially-breaking" | "unverifiable" | "breaking";

/**
 * The kind of a contract change, described from the previous contract to the next one.
 */
export type SchemaChangeKind
  = | "type-narrowed"
    | "type-widened"
    | "value-restricted"
    | "value-unrestricted"
    | "enum-value-removed"
    | "enum-value-added"
    | "constraint-tightened"
    | "constraint-relaxed"
    | "pattern-changed"
    | "format-changed"
    | "required-property-added"
    | "required-property-removed"
    | "optional-became-required"
    | "required-became-optional"
    | "property-removed"
    | "property-added"
    | "additional-properties-restricted"
    | "additional-properties-allowed"
    | "value-rejected"
    | "value-allowed"
    | "unsupported-keyword"
    | "runtime-constraint-added"
    | "runtime-constraint-removed"
    | "fidelity-unverified"
    | "contract-format-changed";

/**
 * Which way data flows for a change.
 *
 * - `backward`: the next contract reading data written under the previous one.
 * - `forward`: the previous contract reading data written under the next one.
 */
export type ChangeDirection = "backward" | "forward";

/** One classified difference between two contracts. */
export interface SchemaChange {
  /** JSON path of the affected value, for example `$.priority`. */
  readonly path: string;
  readonly kind: SchemaChangeKind;
  readonly direction: ChangeDirection;
  readonly certainty: AcceptanceCertainty;
  readonly classification: ChangeClassification;
  /** The previous contract's relevant constraint, when there is one. */
  readonly previous?: string;
  /** The next contract's relevant constraint, when there is one. */
  readonly next?: string;
  readonly message: string;
}

/** The version and fingerprint of one side of a comparison. */
export interface ContractVersion {
  readonly schemaVersion: number;
  readonly fingerprint: string;
}

/**
 * The result of comparing two contract records. JSON-serializable, so it can
 * be stored as the starting point for migration tooling.
 */
export interface SchemaCompatibilityReport {
  readonly subject: string;
  readonly role: ContractRole;
  /** The most severe classification among the changes; `safe` when there are none. */
  readonly classification: ChangeClassification;
  /** `true` when no diagnostic has error severity. */
  readonly compatible: boolean;
  readonly previous: ContractVersion;
  readonly next: ContractVersion;
  readonly changes: readonly SchemaChange[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Settings for {@link checkSchemaCompatibility}. */
export interface CheckSchemaCompatibilityOptions {
  readonly role: ContractRole;
  /** What the contract describes, for example `message for queue "orders"`. Used in diagnostics. */
  readonly subject: string;
}

/** The base classification of each direction, per role. */
const policy: Readonly<Record<ContractRole, Readonly<Record<ChangeDirection, ChangeClassification>>>> = {
  message: { backward: "breaking", forward: "potentially-breaking" },
  request: { backward: "breaking", forward: "safe" },
  response: { backward: "safe", forward: "breaking" }
};

/**
 * Changes that affect the whole contract, whatever the role and direction:
 * an unverified description cannot be trusted, and a different contract
 * format or encoding means existing data is not readable as before.
 */
const contractWideClassifications: Partial<Readonly<Record<SchemaChangeKind, ChangeClassification>>> = {
  "fidelity-unverified": "unverifiable",
  "contract-format-changed": "breaking"
};

/** Severity order of classifications. */
const severity: Readonly<Record<ChangeClassification, number>> = { "safe": 0, "potentially-breaking": 1, "unverifiable": 2, "breaking": 3 };

/** The name of each narrowing when it is seen from the other direction. */
const widened: Readonly<Record<AcceptanceFinding["kind"], SchemaChangeKind>> = {
  "type-narrowed": "type-widened",
  "value-restricted": "value-unrestricted",
  "enum-value-removed": "enum-value-added",
  "constraint-tightened": "constraint-relaxed",
  "pattern-changed": "pattern-changed",
  "format-changed": "format-changed",
  "required-property-added": "required-property-removed",
  "optional-became-required": "required-became-optional",
  "property-removed": "property-added",
  "additional-properties-restricted": "additional-properties-allowed",
  "value-rejected": "value-allowed",
  "unsupported-keyword": "unsupported-keyword"
};

/** Human-readable descriptions of each change kind. */
const describedKinds: Readonly<Record<SchemaChangeKind, string>> = {
  "type-narrowed": "the accepted types were narrowed",
  "type-widened": "the accepted types were widened",
  "value-restricted": "the value was restricted to specific values",
  "value-unrestricted": "the value is no longer restricted to specific values",
  "enum-value-removed": "allowed values were removed",
  "enum-value-added": "allowed values were added",
  "constraint-tightened": "a constraint was tightened",
  "constraint-relaxed": "a constraint was relaxed",
  "pattern-changed": "the pattern changed",
  "format-changed": "the format changed",
  "required-property-added": "a required property was added",
  "required-property-removed": "a required property was removed",
  "optional-became-required": "an optional property became required",
  "required-became-optional": "a required property became optional",
  "property-removed": "a property was removed and undeclared properties are rejected",
  "property-added": "a property was added that the previous contract rejects",
  "additional-properties-restricted": "undeclared properties are now rejected",
  "additional-properties-allowed": "undeclared properties are now allowed",
  "value-rejected": "the value is no longer accepted",
  "value-allowed": "a previously rejected value is now accepted",
  "unsupported-keyword": "a keyword the checker cannot analyze changed",
  "runtime-constraint-added": "a runtime-only constraint was added",
  "runtime-constraint-removed": "a runtime-only constraint was removed",
  "fidelity-unverified": "a contract was described without a verifying adapter",
  "contract-format-changed": "the contract format or encoding changed"
};

/**
 * Compares the wire (input) sides of two versions of a contract and
 * classifies every difference according to the role's policy:
 *
 * | Role | Next rejects previous data (backward) | Previous rejects next data (forward) |
 * | --- | --- | --- |
 * | `message` | breaking | potentially breaking (rolling deployments) |
 * | `request` | breaking | safe |
 * | `response` | safe | breaking |
 *
 * A finding the checker is unsure about is at most potentially breaking, and
 * an unanalyzable one is unverifiable. Diagnostics:
 *
 * - `HOLQA_SCHEMA_CHANGE_BREAKING` (error) for a breaking change without a schema version increase;
 * - `HOLQA_SCHEMA_MIGRATION_REQUIRED` (warning) for a breaking change with an increase;
 * - `HOLQA_SCHEMA_CHANGE_POTENTIALLY_BREAKING` and `HOLQA_SCHEMA_CHANGE_UNVERIFIABLE` (warnings);
 * - `HOLQA_SCHEMA_VERSION_INVALID` (error) when the version decreased.
 *
 * @param previous - The deployed contract record.
 * @param next - The candidate contract record.
 * @param options - The contract's role and subject.
 * @returns The classified changes and diagnostics.
 *
 * @example
 * ```ts
 * const report = checkSchemaCompatibility(deployed, candidate, { role: "message", subject: "message for queue \"orders\"" });
 * if (!report.compatible)
 *   fail(report.diagnostics);
 * ```
 */
export function checkSchemaCompatibility(previous: SchemaContractRecord, next: SchemaContractRecord, options: CheckSchemaCompatibilityOptions): SchemaCompatibilityReport {
  const { role, subject } = options;
  const changes = previous.fingerprint === next.fingerprint ? [] : contractChanges(previous, next, role);
  const diagnostics = [
    ...versionDiagnostics(previous, next, subject),
    ...changes.flatMap(change => changeDiagnostic(change, previous, next, subject))
  ];
  const classification = changes.reduce<ChangeClassification>((worst, change) => severity[change.classification] > severity[worst] ? change.classification : worst, "safe");
  return {
    subject,
    role,
    classification,
    compatible: diagnostics.every(diagnostic => diagnostic.severity !== "error"),
    previous: { schemaVersion: previous.schemaVersion, fingerprint: previous.fingerprint },
    next: { schemaVersion: next.schemaVersion, fingerprint: next.fingerprint },
    changes,
    diagnostics
  };
}

/**
 * Lists every classified change between two contracts with different fingerprints.
 *
 * @param previous - The deployed record.
 * @param next - The candidate record.
 * @param role - Decides the base classification of each direction.
 * @returns The changes: structural ones first (backward, then forward), then runtime-only and fidelity changes.
 */
function contractChanges(previous: SchemaContractRecord, next: SchemaContractRecord, role: ContractRole): SchemaChange[] {
  const before = previous.contract;
  const after = next.contract;
  if (before.format !== after.format || before.encoding !== after.encoding || before.dialect !== after.dialect)
    return [change(role, { path: "$", kind: "contract-format-changed", direction: "backward", certainty: "unknown", previous: `${before.format} ${before.encoding}`, next: `${after.format} ${after.encoding}` })];

  const beforeSchema = canonicalizeJsonSchema(before.input.jsonSchema);
  const afterSchema = canonicalizeJsonSchema(after.input.jsonSchema);
  const changes = [
    ...findRejections(afterSchema, beforeSchema).map(finding => fromFinding(role, finding, "backward")),
    ...findRejections(beforeSchema, afterSchema).map(finding => fromFinding(role, finding, "forward"))
  ];

  const beforeRuntime = runtimeKeys(before.input.runtimeOnly);
  const afterRuntime = runtimeKeys(after.input.runtimeOnly);
  for (const [key, constraint] of afterRuntime) {
    if (!beforeRuntime.has(key))
      changes.push(change(role, { path: constraint.path, kind: "runtime-constraint-added", direction: "backward", certainty: "possible", next: constraint.kind }));
  }
  for (const [key, constraint] of beforeRuntime) {
    if (!afterRuntime.has(key))
      changes.push(change(role, { path: constraint.path, kind: "runtime-constraint-removed", direction: "forward", certainty: "possible", previous: constraint.kind }));
  }
  if (before.source.fidelity === "unverified" || after.source.fidelity === "unverified")
    changes.push(change(role, { path: "$", kind: "fidelity-unverified", direction: "backward", certainty: "unknown" }));
  return changes;
}

/**
 * Converts an acceptance finding to a change. In the forward direction the
 * reader is the previous contract, so narrowings are reported as widenings.
 *
 * @param role - The contract's role.
 * @param finding - A narrowing found by the acceptance checker.
 * @param direction - The direction the finding was computed in.
 * @returns The classified change.
 */
function fromFinding(role: ContractRole, finding: AcceptanceFinding, direction: ChangeDirection): SchemaChange {
  const backward = direction === "backward";
  return change(role, {
    path: finding.path,
    kind: backward ? finding.kind : widened[finding.kind],
    direction,
    certainty: finding.certainty,
    ...optionalText("previous", backward ? finding.writer : finding.reader),
    ...optionalText("next", backward ? finding.reader : finding.writer)
  });
}

/** The fields of a change before it is classified and described. */
type UnclassifiedChange = Omit<SchemaChange, "classification" | "message">;

/**
 * Classifies a change by the role's policy and its certainty, and describes it.
 *
 * @param role - The contract's role.
 * @param unclassified - The change without classification and message.
 * @returns The complete change.
 */
function change(role: ContractRole, unclassified: UnclassifiedChange): SchemaChange {
  // Whether the contract can be trusted at all does not depend on who reads it.
  const contractWide = contractWideClassifications[unclassified.kind];
  if (contractWide !== undefined)
    return { ...unclassified, classification: contractWide, message: `At ${unclassified.path}, ${describedKinds[unclassified.kind]}.` };
  const base = policy[role][unclassified.direction];
  const classification: ChangeClassification = base === "safe"
    ? "safe"
    : unclassified.certainty === "definite"
      ? base
      : unclassified.certainty === "possible" ? "potentially-breaking" : "unverifiable";
  const values = unclassified.previous !== undefined || unclassified.next !== undefined
    ? ` (previous: ${unclassified.previous ?? "none"}; next: ${unclassified.next ?? "none"})`
    : "";
  return { ...unclassified, classification, message: `At ${unclassified.path}, ${describedKinds[unclassified.kind]}${values}.` };
}

/**
 * Creates the diagnostic for one change, if its classification needs one.
 *
 * @param change - The classified change.
 * @param previous - The deployed record.
 * @param next - The candidate record.
 * @param subject - What the contract describes.
 * @returns Zero or one diagnostic.
 */
function changeDiagnostic(change: SchemaChange, previous: SchemaContractRecord, next: SchemaContractRecord, subject: string): Diagnostic[] {
  const details: JsonObject = {
    subject,
    path: change.path,
    kind: change.kind,
    direction: change.direction,
    classification: change.classification,
    previousVersion: previous.schemaVersion,
    nextVersion: next.schemaVersion
  };
  const message = `The ${subject} changed incompatibly. ${change.message}`;
  switch (change.classification) {
    case "safe":
      return [];
    case "breaking":
      return next.schemaVersion > previous.schemaVersion
        ? [createDiagnostic({
          code: diagnosticCodes.schemaMigrationRequired,
          severity: "warning",
          message: `${message} Data written with schema version ${previous.schemaVersion} will be rejected by version ${next.schemaVersion}.`,
          hint: `Drain or migrate data written with version ${previous.schemaVersion} before the new version reads it.`,
          details
        })]
        : [createDiagnostic({
          code: diagnosticCodes.schemaChangeBreaking,
          severity: "error",
          message,
          hint: `Make the change compatible (for example, add the property as optional), or increase schemaVersion above ${previous.schemaVersion} and plan a migration.`,
          details
        })];
    case "potentially-breaking":
      return [createDiagnostic({ code: diagnosticCodes.schemaChangePotentiallyBreaking, severity: "warning", message: `The ${subject} may reject some data. ${change.message}`, details })];
    case "unverifiable":
      return [createDiagnostic({ code: diagnosticCodes.schemaChangeUnverifiable, severity: "warning", message: `The ${subject} changed in a way Holqa cannot verify. ${change.message}`, details })];
  }
}

/**
 * Reports a decreased schema version.
 *
 * @param previous - The deployed record.
 * @param next - The candidate record.
 * @param subject - What the contract describes.
 * @returns Zero or one `HOLQA_SCHEMA_VERSION_INVALID` error.
 */
function versionDiagnostics(previous: SchemaContractRecord, next: SchemaContractRecord, subject: string): Diagnostic[] {
  if (next.schemaVersion >= previous.schemaVersion)
    return [];
  return [createDiagnostic({
    code: diagnosticCodes.schemaVersionInvalid,
    severity: "error",
    message: `The schema version of the ${subject} decreased from ${previous.schemaVersion} to ${next.schemaVersion}.`,
    hint: "Schema versions only increase. Data may already exist for every version that was deployed.",
    details: { subject, previousVersion: previous.schemaVersion, nextVersion: next.schemaVersion }
  })];
}

/**
 * Indexes runtime-only constraints by path and kind.
 *
 * @param constraints - A side's runtime-only constraints.
 * @returns The constraints keyed by `kind path`.
 */
function runtimeKeys(constraints: readonly RuntimeOnlyConstraint[]): Map<string, RuntimeOnlyConstraint> {
  return new Map(constraints.map(constraint => [`${constraint.kind} ${constraint.path}`, constraint]));
}

/**
 * Builds an optional text property, omitted when the text is absent.
 *
 * @param key - The property name.
 * @param text - The value to store, or `undefined` to omit the property.
 * @returns An object with the property, or an empty object.
 */
function optionalText<Key extends "previous" | "next">(key: Key, text: string | undefined): { [K in Key]?: string } {
  return text === undefined ? {} : { [key]: text } as { [K in Key]?: string };
}