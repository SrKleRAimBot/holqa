import type { Diagnostic } from "@/diagnostics/diagnostic";
import type {
  JsonObject,
  JsonValue
} from "@/json";
import type {
  InferOutput,
  StandardSchemaIssue,
  StandardSchemaV1
} from "@/schema/standard-schema";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";
import { HolqaError } from "@/errors/holqa-error";

/** One segment of a validation issue path: an object key or an array index. */
export type ValidationPathSegment = string | number;

/**
 * A schema validation issue reduced to JSON-safe data. It identifies the
 * failing field but never carries the rejected value, which may be sensitive.
 */
export interface ValidationIssue {
  readonly message: string;
  /** Dotted path such as `lines.0.sku`; empty for a problem with the whole value. */
  readonly path: string;
  /** The path as separate segments, for example `["lines", 0, "sku"]`. Empty for the whole value. */
  readonly segments: readonly ValidationPathSegment[];
  /** The path as an RFC 6901 JSON Pointer, for example `/lines/0/sku`. Empty for the whole value. */
  readonly pointer: string;
  /**
   * Library-specific facts about the issue, such as Zod's `code`, `expected`
   * or `minimum`. Only scalar (or scalar array) fields are kept; the rejected
   * `input` is always dropped. Absent when the library reports none.
   */
  readonly details?: JsonObject;
}

/**
 * The fields needed to construct an {@link InputValidationError}. Only
 * `message` and `path` are required; the other path forms are derived from
 * the dotted path when absent, which keeps callers written against the
 * original two-field issue shape working.
 */
export interface ValidationIssueInit {
  readonly message: string;
  readonly path: string;
  readonly segments?: readonly ValidationPathSegment[];
  readonly pointer?: string;
  readonly details?: JsonObject;
}

/** Thrown when untrusted input fails schema validation at a trust boundary. */
export class InputValidationError extends HolqaError {
  /** The normalized issues reported by the schema. */
  readonly issues: readonly ValidationIssue[];

  /**
   * Creates an error with one `HOLQA_INPUT_INVALID` diagnostic that names what
   * was validated and why it failed. The diagnostic's `details.issues` lists
   * every issue with its path, so tools can point at the failing field.
   *
   * @param subject - What was validated, for example `message for queue "order-processing"`.
   * @param issues - The validation issues, normalized or in the original `{ message, path }` form.
   */
  constructor(subject: string, issues: readonly ValidationIssueInit[]) {
    const frozen = Object.freeze(issues.map(freezeIssue));
    super(inputInvalid(subject, frozen));
    this.name = "InputValidationError";
    this.issues = frozen;
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
    throw new InputValidationError(subject, result.issues.map(normalizeIssue));
  return result.value as InferOutput<Schema>;
}

/**
 * Converts a Standard Schema issue to a {@link ValidationIssue}: the message,
 * the path in three forms and the scalar library-specific details.
 *
 * @param issue - A Standard Schema issue reported by any library.
 * @returns The normalized, JSON-safe issue.
 */
export function normalizeIssue(issue: StandardSchemaIssue): ValidationIssue {
  const segments = (issue.path ?? [])
    .map(segment => typeof segment === "object" ? segment.key : segment)
    .map(key => typeof key === "symbol" ? key.toString() : key);
  const details = issueDetails(issue);
  return {
    message: issue.message,
    path: segments.map(String).join("."),
    segments,
    pointer: toPointer(segments),
    ...(details === undefined ? {} : { details })
  };
}

/**
 * Formats path segments as an RFC 6901 JSON Pointer, escaping `~` and `/`.
 *
 * @param segments - The path segments.
 * @returns The pointer, for example `/lines/0/sku`, or an empty string for the root.
 */
function toPointer(segments: readonly ValidationPathSegment[]): string {
  return segments.map(segment => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

/** Issue properties that are never copied into details: the standard fields and the rejected value itself. */
const excludedIssueKeys: ReadonlySet<string> = new Set(["message", "path", "input"]);

/**
 * Copies the scalar, library-specific properties of an issue (for example
 * Zod's `code: "too_small"` and `minimum: 1`). Nested structures, functions
 * and the rejected input are skipped, so details stay small and never leak data.
 *
 * @param issue - The issue to read.
 * @returns The details, or `undefined` when the issue carries none.
 */
function issueDetails(issue: StandardSchemaIssue): JsonObject | undefined {
  const details: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(issue)) {
    if (excludedIssueKeys.has(key))
      continue;
    const copy: JsonValue | undefined = isScalar(value) ? value : Array.isArray(value) && value.every(isScalar) ? [...value] : undefined;
    // defineProperty, so that a "__proto__" key stays an own property.
    if (copy !== undefined)
      Object.defineProperty(details, key, { value: copy, enumerable: true, writable: true, configurable: true });
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

/**
 * Reports whether a value is a JSON scalar: a string, a boolean, a finite number or `null`.
 *
 * @param value - The value to inspect.
 * @returns `true` for JSON scalars.
 */
function isScalar(value: unknown): value is string | boolean | number | null {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Completes and deep-freezes an issue so that errors cannot be altered after they are thrown.
 *
 * @param issue - The issue to complete and freeze.
 * @returns A frozen, complete copy.
 */
function freezeIssue(issue: ValidationIssueInit): ValidationIssue {
  // Older callers construct issues with only `message` and `path`; derive the
  // other forms from the dotted path, best effort: digit-only segments become
  // array indexes, and keys that themselves contain "." cannot be recovered.
  const segments = issue.segments ?? (issue.path === "" ? [] : issue.path.split(".").map(segment => /^(?:0|[1-9]\d*)$/.test(segment) ? Number(segment) : segment));
  const pointer = issue.pointer ?? toPointer(segments);
  return Object.freeze({
    message: issue.message,
    path: issue.path,
    segments: Object.freeze([...segments]),
    pointer,
    ...(issue.details === undefined ? {} : { details: Object.freeze({ ...issue.details }) })
  });
}

/**
 * Builds the diagnostic for failed input validation. The message lists each
 * issue's path and message but never the rejected value, which may be sensitive.
 *
 * @param subject - What was validated.
 * @param issues - The normalized issues.
 * @returns An error-severity `HOLQA_INPUT_INVALID` diagnostic with the issues under `details.issues`.
 */
function inputInvalid(subject: string, issues: readonly ValidationIssue[]): Diagnostic {
  const summary = issues.map(issue => issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`).join("; ");
  const details: JsonObject = {
    subject,
    issues: issues.map(issue => ({
      path: issue.path,
      pointer: issue.pointer,
      segments: [...issue.segments],
      message: issue.message,
      ...(issue.details === undefined ? {} : { details: issue.details })
    }))
  };
  return createDiagnostic({ code: diagnosticCodes.inputInvalid, severity: "error", message: `Invalid ${subject}: ${summary}`, details });
}