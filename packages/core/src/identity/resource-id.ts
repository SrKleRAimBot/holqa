import type { Diagnostic } from "@/diagnostics/diagnostic";
import type { Result } from "@/result";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";
import {
  err,
  ok
} from "@/result";

/**
 * The maximum length of a resource identifier, in characters.
 */
export const maxResourceIdLength = 63;

/**
 * Lowercase alphanumeric segments separated by single `-` or `.` characters,
 * starting with a letter.
 */
const resourceIdPattern = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

declare const resourceIdBrand: unique symbol;

/**
 * A validated, stable logical identifier for a Holqa resource or handler.
 *
 * Resource identifiers are the persistent identity of logical infrastructure.
 * They are intentionally independent of TypeScript property names so that
 * renaming a variable never implies replacing infrastructure.
 *
 * Construct values with {@link parseResourceId}; the brand prevents passing
 * unvalidated strings where a `ResourceId` is required.
 */
export type ResourceId = string & { readonly [resourceIdBrand]: true };

/**
 * Validates an untrusted value against the resource identifier grammar.
 *
 * Valid identifiers are 1 to {@link maxResourceIdLength} characters long,
 * start with a lowercase letter, and consist of lowercase alphanumeric
 * segments separated by single `-` or `.` characters (for example
 * `order-processing` or `orders.process`).
 *
 * This function never throws: invalid input produces an error diagnostic with
 * the code `HOLQA_RESOURCE_ID_INVALID`.
 *
 * @param value - The untrusted candidate identifier.
 * @returns The branded identifier, or a diagnostic describing why it is invalid.
 *
 * @example
 * ```ts
 * const result = parseResourceId("order-processing");
 * if (result.ok)
 *   console.log(result.value);
 * ```
 */
export function parseResourceId(value: unknown): Result<ResourceId, Diagnostic> {
  if (typeof value !== "string")
    return err(invalidResourceId(`Resource identifier must be a string, received ${describeType(value)}.`));
  if (value.length === 0)
    return err(invalidResourceId("Resource identifier must not be empty."));
  if (value.length > maxResourceIdLength)
    return err(invalidResourceId(`Resource identifier "${value}" exceeds ${maxResourceIdLength} characters.`));
  if (!resourceIdPattern.test(value)) {
    return err(invalidResourceId(
      `Resource identifier "${value}" is invalid.`,
      "Use lowercase letters and digits, start with a letter, and separate segments with a single \"-\" or \".\"."
    ));
  }
  return ok(value as ResourceId);
}

/**
 * Determines whether a value satisfies the resource identifier grammar.
 *
 * @param value - The untrusted candidate identifier.
 * @returns `true` when {@link parseResourceId} would succeed for `value`.
 */
export function isResourceId(value: unknown): value is ResourceId {
  return parseResourceId(value).ok;
}

/**
 * Builds the error diagnostic used for every identifier validation failure.
 *
 * @param message - A description of the specific violation.
 * @param hint - Optional guidance for fixing the identifier.
 * @returns An error-severity diagnostic with code `HOLQA_RESOURCE_ID_INVALID`.
 */
function invalidResourceId(message: string, hint?: string): Diagnostic {
  return createDiagnostic({
    code: diagnosticCodes.resourceIdInvalid,
    severity: "error",
    message,
    ...(hint === undefined ? {} : { hint })
  });
}

/**
 * Describes the runtime type of an arbitrary value for use in error messages,
 * distinguishing `null` and arrays from plain objects.
 *
 * @param value - The value to describe.
 * @returns A short type name such as `number`, `null`, or `array`.
 */
function describeType(value: unknown): string {
  if (value === null)
    return "null";
  return Array.isArray(value) ? "array" : typeof value;
}