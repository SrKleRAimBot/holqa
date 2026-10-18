import type {
  Diagnostic,
  JsonObject,
  Result,
  RuntimeOnlyConstraint,
  SchemaAdapter,
  SchemaConversionProblem,
  SchemaSide,
  SchemaSideConversion,
  SchemaSideDescription,
  StandardSchemaV1
} from "@holqa/core";

import type {
  SchemaContract,
  SchemaContractRecord,
  SchemaOutputContract,
  SchemaSource
} from "@/schema/schema-contract";

import {
  createDiagnostic,
  diagnosticCodes,
  err,
  hasStandardJsonSchema,
  isJsonValue,
  isStandardSchema,
  ok
} from "@holqa/core";

import { canonicalizeJsonSchema } from "@/schema/canonical-json-schema";
import { fingerprintSchemaContract } from "@/schema/fingerprint";
import {
  jsonSchemaDialect,
  schemaContractFormat
} from "@/schema/schema-contract";

/** Settings for {@link normalizeSchema}. */
export interface NormalizeSchemaOptions {
  /** What the schema describes, for example `message for queue "orders"`. Used in diagnostics. */
  readonly subject: string;
  /**
   * Library-specific adapters, matched by Standard Schema vendor. The first
   * adapter for a vendor wins. Without a matching adapter, schemas that
   * implement Standard JSON Schema are described as `unverified`.
   */
  readonly adapters?: readonly SchemaAdapter[] | undefined;
}

/** A normalized schema and the non-fatal diagnostics normalization produced. */
export interface NormalizedSchema {
  readonly contract: SchemaContract;
  /**
   * Warnings: `HOLQA_SCHEMA_FIDELITY_UNVERIFIED` for the generic path and one
   * `HOLQA_SCHEMA_RUNTIME_ONLY` per constraint the description cannot express.
   */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Converts a schema into Holqa's canonical contract. Never approximates: a
 * construct the description cannot express is either recorded as a
 * runtime-only constraint (with a warning) or rejects the schema.
 *
 * The input side must be portable, because it is what travels on the wire.
 * The output side may be unrepresentable (for example a transform to `Date`);
 * that is recorded in the contract and is not an error.
 *
 * Trust assumption: the value is checked structurally, but describing it runs
 * the schema library's (and therefore possibly the application's) code
 * in-process. Only normalize schemas from code you would also execute.
 *
 * @param schema - The schema to normalize. Any value is accepted and checked structurally before use.
 * @param options - The subject used in diagnostics and the available adapters.
 * @returns The contract and its warnings, or every error diagnostic (`HOLQA_SCHEMA_UNSUPPORTED`).
 *
 * @example
 * ```ts
 * const result = normalizeSchema(orderSchema, { subject: "message for queue \"orders\"", adapters: [zodAdapter] });
 * if (!result.ok)
 *   report(result.error);
 * ```
 */
export function normalizeSchema(schema: unknown, options: NormalizeSchemaOptions): Result<NormalizedSchema, readonly Diagnostic[]> {
  const { subject } = options;
  if (!isStandardSchema(schema))
    return err([unsupported(subject, { path: "$", reason: "the value does not implement Standard Schema v1.", hint: "Pass a schema from a Standard Schema library such as Zod." })]);

  const vendor = schema["~standard"].vendor;
  const adapter = options.adapters?.find(candidate => candidate.vendor === vendor);
  const diagnostics: Diagnostic[] = [];
  let source: SchemaSource;
  let describe: (side: SchemaSide) => SchemaSideConversion;
  if (adapter !== undefined) {
    source = { vendor, library: adapter.library, fidelity: "verified" };
    describe = side => describeWithAdapter(adapter, schema, side);
  } else if (hasStandardJsonSchema(schema)) {
    source = { vendor, library: `${vendor} (Standard JSON Schema)`, fidelity: "unverified" };
    describe = side => describeWithStandardJsonSchema(schema, side);
    diagnostics.push(createDiagnostic({
      code: diagnosticCodes.schemaFidelityUnverified,
      severity: "warning",
      message: `The ${subject} was described by vendor "${vendor}"'s own JSON Schema converter, which may omit constraints without reporting them.`,
      hint: "Use a Holqa schema adapter for this library when one exists.",
      details: { subject, vendor }
    }));
  } else {
    return err([unsupported(subject, {
      path: "$",
      reason: `vendor "${vendor}" has no Holqa schema adapter and does not implement Standard JSON Schema.`,
      hint: "Install the Holqa adapter for this schema library, for example @holqa/zod."
    })]);
  }

  const input = describe("input");
  if (!input.ok)
    return err([unsupported(subject, input.error)]);
  const output = describe("output");
  const outputContract: SchemaOutputContract = output.ok
    ? { representable: true, ...output.value }
    : { representable: false, problem: output.error };

  diagnostics.push(...runtimeOnlyDiagnostics(subject, input.value.runtimeOnly));
  const contract: SchemaContract = {
    format: schemaContractFormat,
    dialect: jsonSchemaDialect,
    encoding: "json",
    source,
    input: input.value,
    output: outputContract
  };
  return ok({ contract, diagnostics });
}

/** Settings for {@link describeSchemaContract}. */
export interface DescribeSchemaContractOptions extends NormalizeSchemaOptions {
  /** The declared schema version, a positive integer. */
  readonly schemaVersion: number;
}

/** A contract record and the non-fatal diagnostics produced while building it. */
export interface DescribedSchemaContract {
  readonly record: SchemaContractRecord;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Normalizes a schema and fingerprints the result, producing the versioned
 * record the compiler stores and the compatibility checker compares.
 *
 * @param schema - The schema to describe.
 * @param options - The subject, adapters and declared schema version.
 * @returns The record and its warnings, or every error diagnostic
 * (`HOLQA_SCHEMA_UNSUPPORTED`, `HOLQA_SCHEMA_VERSION_INVALID`).
 */
export async function describeSchemaContract(schema: unknown, options: DescribeSchemaContractOptions): Promise<Result<DescribedSchemaContract, readonly Diagnostic[]>> {
  const { schemaVersion, subject } = options;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    return err([createDiagnostic({
      code: diagnosticCodes.schemaVersionInvalid,
      severity: "error",
      message: `The schema version of the ${subject} must be a positive integer.`,
      details: { subject }
    })]);
  }
  const normalized = normalizeSchema(schema, options);
  if (!normalized.ok)
    return normalized;
  const { contract, diagnostics } = normalized.value;
  return ok({ record: { schemaVersion, fingerprint: await fingerprintSchemaContract(contract), contract }, diagnostics });
}

/**
 * Describes one side through a vendor adapter, turning adapter exceptions and
 * malformed output into conversion problems instead of hiding them.
 *
 * @param adapter - The adapter for the schema's vendor.
 * @param schema - The schema whose vendor matches the adapter.
 * @param side - The side to describe.
 * @returns The canonical description, or the problem.
 */
function describeWithAdapter(adapter: SchemaAdapter, schema: StandardSchemaV1, side: SchemaSide): SchemaSideConversion {
  let conversion: SchemaSideConversion;
  try {
    conversion = adapter.describe(schema, side);
  } catch (error) {
    return err({ path: "$", reason: `the ${adapter.library} adapter failed: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!conversion.ok)
    return conversion;
  const runtimeOnly: unknown = conversion.value.runtimeOnly;
  if (!Array.isArray(runtimeOnly) || !runtimeOnly.every(isRuntimeOnlyConstraint))
    return err({ path: "$", reason: `the ${adapter.library} adapter reported malformed runtime-only constraints.` });
  return canonicalDescription(conversion.value.jsonSchema, runtimeOnly);
}

/**
 * Describes one side through the schema's own Standard JSON Schema converter.
 * The result cannot be verified, and the caller reports that.
 *
 * @param schema - A schema implementing Standard JSON Schema.
 * @param side - The side to describe.
 * @returns The canonical description, or the converter's error as a problem.
 */
function describeWithStandardJsonSchema(schema: StandardSchemaV1, side: SchemaSide): SchemaSideConversion {
  if (!hasStandardJsonSchema(schema))
    return err({ path: "$", reason: "the schema does not implement Standard JSON Schema." });
  let raw: Record<string, unknown>;
  try {
    raw = schema["~standard"].jsonSchema[side]({ target: "draft-2020-12" });
  } catch (error) {
    return err({ path: "$", reason: error instanceof Error ? error.message : String(error) });
  }
  return canonicalDescription(raw, []);
}

/**
 * Checks that a converter produced a plain JSON object and returns it in canonical form.
 *
 * @param raw - The converter's JSON Schema.
 * @param runtimeOnly - The runtime-only constraints reported with it.
 * @returns The canonical description, or a problem when the output is not plain JSON.
 */
function canonicalDescription(raw: unknown, runtimeOnly: readonly RuntimeOnlyConstraint[]): SchemaSideConversion {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !isJsonValue(raw))
    return err({ path: "$", reason: "the converter did not produce a plain JSON Schema object." });
  const description: SchemaSideDescription = {
    jsonSchema: canonicalizeJsonSchema(raw as JsonObject),
    runtimeOnly: [...runtimeOnly].map(constraint => ({ path: constraint.path, kind: constraint.kind, detail: constraint.detail }))
  };
  return ok(description);
}

/** Every runtime-only kind an adapter may report. */
const runtimeOnlyKinds: ReadonlySet<string> = new Set(["refinement", "rewrite", "coercion", "preprocess", "fallback", "pipe", "check"]);

/**
 * Checks one runtime-only constraint reported by a third-party adapter.
 *
 * @param value - The reported entry.
 * @returns `true` for an object with string `path` and `detail` and a known `kind`.
 */
function isRuntimeOnlyConstraint(value: unknown): value is RuntimeOnlyConstraint {
  if (typeof value !== "object" || value === null)
    return false;
  const { path, kind, detail } = value as { path?: unknown; kind?: unknown; detail?: unknown };
  return typeof path === "string" && typeof detail === "string" && typeof kind === "string" && runtimeOnlyKinds.has(kind);
}

/**
 * Creates one `HOLQA_SCHEMA_RUNTIME_ONLY` warning per runtime-only constraint.
 *
 * @param subject - What the schema describes.
 * @param constraints - The input side's runtime-only constraints.
 * @returns The warnings, in the adapter's order.
 */
function runtimeOnlyDiagnostics(subject: string, constraints: readonly RuntimeOnlyConstraint[]): Diagnostic[] {
  return constraints.map(constraint => createDiagnostic({
    code: diagnosticCodes.schemaRuntimeOnly,
    severity: "warning",
    message: `The ${subject} has a constraint at ${constraint.path} that is validated at runtime only: ${constraint.detail}`,
    hint: "Generated clients and documentation will not show this constraint. Express it with a portable construct if consumers need to know it.",
    details: { subject, path: constraint.path, kind: constraint.kind }
  }));
}

/**
 * Creates the `HOLQA_SCHEMA_UNSUPPORTED` error for a conversion problem.
 *
 * @param subject - What the schema describes.
 * @param problem - Where and why conversion failed.
 * @returns The error diagnostic.
 */
function unsupported(subject: string, problem: SchemaConversionProblem): Diagnostic {
  return createDiagnostic({
    code: diagnosticCodes.schemaUnsupported,
    severity: "error",
    message: `The ${subject} cannot be used as a portable contract: ${problem.path === "$" ? "" : `${problem.path}: `}${problem.reason}`,
    ...(problem.hint === undefined ? {} : { hint: problem.hint }),
    details: { subject, path: problem.path }
  });
}