import type { Diagnostic } from "@/diagnostics/diagnostic";
import type {
  InferOutput,
  StandardSchemaIssue,
  StandardSchemaV1
} from "@/schema/standard-schema";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";
import { HolqaError } from "@/errors/holqa-error";

/** A schema validation issue reduced to JSON-safe data: a message and a dotted path. */
export interface ValidationIssue {
  readonly message: string;
  /** Dotted path such as `lines.0.sku`; empty for a problem with the whole value. */
  readonly path: string;
}

/** Thrown when untrusted input fails schema validation at a trust boundary. */
export class InputValidationError extends HolqaError {
  /** The normalized issues reported by the schema. */
  readonly issues: readonly ValidationIssue[];

  /**
   * Creates an error with one `HOLQA_INPUT_INVALID` diagnostic that names what was validated and why it failed.
   *
   * @param subject - What was validated, for example `message for queue "order-processing"`.
   * @param issues - The normalized validation issues.
   */
  constructor(subject: string, issues: readonly ValidationIssue[]) {
    super(inputInvalid(subject, issues));
    this.name = "InputValidationError";
    this.issues = Object.freeze(issues.map(issue => Object.freeze({ ...issue })));
  }
}

/**
 * Validates untrusted input with any Standard Schema and returns the schema's
 * output. Always awaits, because schemas may validate asynchronously.
 *
 * @param schema - The schema to validate against.
 * @param value - The untrusted value.
 * @param subject - What is being validated, used in the error message.
 * @returns The schema's output value, which may differ from the input when the schema transforms it.
 * @throws {InputValidationError} When the schema reports issues (code `HOLQA_INPUT_INVALID`).
 */
export async function validateInput<Schema extends StandardSchemaV1>(schema: Schema, value: unknown, subject: string): Promise<InferOutput<Schema>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined)
    throw new InputValidationError(subject, result.issues.map(issue => ({ message: issue.message, path: formatIssuePath(issue) })));
  return result.value as InferOutput<Schema>;
}

/**
 * Converts a Standard Schema issue path to a dotted string such as `lines.0.sku`.
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
 * Builds the diagnostic for failed input validation. The message lists each
 * issue's path and message but never the rejected value, which may be sensitive.
 *
 * @param subject - What was validated.
 * @param issues - The normalized issues.
 * @returns An error-severity `HOLQA_INPUT_INVALID` diagnostic.
 */
function inputInvalid(subject: string, issues: readonly ValidationIssue[]): Diagnostic {
  const details = issues.map(issue => issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`).join("; ");
  return createDiagnostic({ code: diagnosticCodes.inputInvalid, severity: "error", message: `Invalid ${subject}: ${details}` });
}