import type { Diagnostic } from "@holqa/core";
import type {
  ExperimentCode,
  ExperimentDiagnostic
} from "@holqa/experiment-model";

import {
  errorCode,
  experimentDiagnostic,
  HolqaError
} from "@holqa/experiment-model";

/** A diagnostic produced by the runtime: an experiment diagnostic or a registered core diagnostic. */
export type RuntimeDiagnostic = ExperimentDiagnostic | Diagnostic;

/**
 * Creates an error-severity runtime diagnostic.
 *
 * @param code - The experiment diagnostic code.
 * @param message - A human-readable description.
 * @param extra - Optional location file and hint.
 * @param extra.file - The application-relative file the problem refers to.
 * @param extra.hint - Actionable guidance.
 * @returns A frozen diagnostic.
 */
export function runtimeError(code: ExperimentCode, message: string, extra: { readonly file?: string; readonly hint?: string } = {}): ExperimentDiagnostic {
  return experimentDiagnostic({
    code,
    severity: "error",
    message,
    ...(extra.file === undefined ? {} : { location: { file: extra.file } }),
    ...(extra.hint === undefined ? {} : { hint: extra.hint })
  });
}

/**
 * Creates a {@link HolqaError} from a code and message.
 *
 * @param code - The experiment diagnostic code.
 * @param message - A human-readable description.
 * @returns The error, ready to throw or reject with.
 */
export function holqaError(code: ExperimentCode, message: string): HolqaError {
  return new HolqaError(runtimeError(code, message));
}

/**
 * Describes a caught value without trusting its type, for diagnostics.
 *
 * @param error - Any thrown value.
 * @returns The error's message, or a string rendering of a non-error value.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reports whether a caught value is a Holqa error with the given code.
 *
 * @param error - Any thrown value.
 * @param code - The code to compare with.
 * @returns `true` when the value carries a diagnostic with `code`.
 */
export function hasCode(error: unknown, code: ExperimentCode): boolean {
  return errorCode(error) === code;
}