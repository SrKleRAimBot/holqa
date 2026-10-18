import type { Diagnostic } from "@/diagnostics/diagnostic";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";

/** The longest object key, in UTF-8 bytes. */
export const maxObjectKeyBytes = 1024;

/**
 * Checks an object key against the portable key rules, which every binding
 * accepts: 1 to 1024 UTF-8 bytes, no control characters, no leading `/`, and
 * no `.` or `..` path segments. Keys are otherwise opaque: `/` has no meaning
 * beyond being a character prefixes can contain.
 *
 * @param key - The untrusted key.
 * @param operation - What was attempted, for the message (for example `bucket "uploads" put`).
 * @returns A `HOLQA_OBJECT_KEY_INVALID` diagnostic, or `undefined` when the key is valid.
 */
export function checkObjectKey(key: unknown, operation: string): Diagnostic | undefined {
  const problem = objectKeyProblem(key);
  if (problem === undefined)
    return undefined;
  return createDiagnostic({
    code: diagnosticCodes.objectKeyInvalid,
    severity: "error",
    message: `${operation} received an invalid object key: ${problem}.`,
    hint: "Use 1 to 1024 bytes without control characters, a leading \"/\", or \".\" and \"..\" segments."
  });
}

/**
 * Describes what is wrong with a key.
 *
 * @param key - The untrusted key.
 * @returns A short description, or `undefined` for a valid key.
 */
function objectKeyProblem(key: unknown): string | undefined {
  if (typeof key !== "string")
    return "the key must be a string";
  if (key.length === 0)
    return "the key is empty";
  if (new TextEncoder().encode(key).length > maxObjectKeyBytes)
    return `the key is longer than ${maxObjectKeyBytes} bytes`;
  if (hasControlCharacter(key))
    return "the key contains a control character";
  if (key.startsWith("/"))
    return "the key starts with \"/\"";
  if (key.split("/").some(segment => segment === "." || segment === ".."))
    return "the key contains a \".\" or \"..\" segment";
  return undefined;
}

/**
 * Reports whether a string contains a control character (U+0000 to U+001F, or
 * U+007F), which several storage services reject or mangle.
 *
 * @param value - The string to scan.
 * @returns `true` when a control character occurs.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7F)
      return true;
  }
  return false;
}