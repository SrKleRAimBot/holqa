import type {
  StandardSchemaIssue,
  StandardSchemaV1
} from "@/standard-schema";

import {
  experimentCodes,
  experimentDiagnostic,
  HolqaError
} from "@/diagnostics";

/** A validation issue reduced to JSON-safe data: a message and a dotted path. */
export interface ValidationIssue {
  readonly message: string;
  readonly path: string;
}

/** Thrown when untrusted input fails schema validation at a trust boundary. */
export class InputValidationError extends HolqaError {
  /** The normalized issues reported by the schema. */
  readonly issues: readonly ValidationIssue[];

  /**
   * Creates an error describing which input failed validation and why.
   *
   * @param subject - What was validated, for example `queue order-processing message`.
   * @param issues - The normalized validation issues.
   */
  constructor(subject: string, issues: readonly ValidationIssue[]) {
    super(experimentDiagnostic({
      code: experimentCodes.inputInvalid,
      severity: "error",
      message: `Invalid ${subject}: ${issues.map(issue => issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`).join("; ")}`
    }));
    this.name = "InputValidationError";
    this.issues = issues;
  }
}

/**
 * Converts a Standard Schema issue path to a dotted string such as `items.0.sku`.
 *
 * @param issue - A Standard Schema issue.
 * @returns The dotted path, or an empty string for root-level issues.
 */
function formatIssuePath(issue: StandardSchemaIssue): string {
  return (issue.path ?? [])
    .map(segment => typeof segment === "object" ? segment.key : segment)
    .map(key => typeof key === "symbol" ? key.toString() : String(key))
    .join(".");
}

/**
 * Validates untrusted input with any Standard Schema. Always awaits, because
 * a schema may validate asynchronously (for example Zod with async refinements).
 *
 * @param schema - The schema to validate against.
 * @param value - The untrusted value.
 * @param subject - What is being validated, used in the error message.
 * @returns The schema's output value, which may be transformed.
 * @throws {InputValidationError} When the schema reports issues.
 */
export async function validateInput<Schema extends StandardSchemaV1>(schema: Schema, value: unknown, subject: string): Promise<NonNullable<Schema["~standard"]["types"]>["output"]> {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined)
    throw new InputValidationError(subject, result.issues.map(issue => ({ message: issue.message, path: formatIssuePath(issue) })));
  return result.value;
}