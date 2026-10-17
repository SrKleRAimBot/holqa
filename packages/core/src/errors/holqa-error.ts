import type { DiagnosticCode } from "@/diagnostics/codes";
import type { Diagnostic } from "@/diagnostics/diagnostic";

import {
  createDiagnostic,
  formatDiagnostic
} from "@/diagnostics/diagnostic";

/**
 * An exception that carries one or more structured diagnostics.
 *
 * Holqa throws `HolqaError` for programmer errors that must stop the current
 * operation, such as an invalid declaration or using a resource handle outside
 * a runtime. Expected, recoverable failures use `Result` instead. Match on
 * `diagnostics[n].code`, never on the message text.
 */
export class HolqaError extends Error {
  /** Every problem found, in the order it was detected. Never empty. */
  readonly diagnostics: readonly Diagnostic[];

  /**
   * Creates an error whose message lists every diagnostic in human-readable form.
   *
   * @param diagnostics - One diagnostic, or a non-empty list of them.
   * @param options - Standard error options, such as the underlying `cause`.
   * @throws {RangeError} When `diagnostics` is an empty list.
   */
  constructor(diagnostics: Diagnostic | readonly Diagnostic[], options?: ErrorOptions) {
    const list: readonly Diagnostic[] = Array.isArray(diagnostics) ? diagnostics : [diagnostics as Diagnostic];
    if (list.length === 0)
      throw new RangeError("HolqaError requires at least one diagnostic.");
    super(list.map(formatDiagnostic).join("\n"), options);
    this.name = "HolqaError";
    this.diagnostics = Object.freeze([...list]);
  }

  /**
   * The code of the first diagnostic, for the common single-problem case.
   *
   * @returns The first diagnostic's code.
   */
  get code(): DiagnosticCode {
    return this.diagnostics[0]!.code;
  }
}

/**
 * Throws a {@link HolqaError} with a single error-severity diagnostic.
 *
 * @param code - The registered diagnostic code.
 * @param message - A human-readable description of the problem.
 * @param hint - Optional, actionable guidance.
 * @throws {HolqaError} Always.
 */
export function failWith(code: DiagnosticCode, message: string, hint?: string): never {
  throw new HolqaError(createDiagnostic({ code, severity: "error", message, ...(hint === undefined ? {} : { hint }) }));
}

/**
 * Returns the diagnostics carried by a caught value, recognizing errors from
 * any copy of `@holqa/core` by shape rather than by `instanceof`.
 *
 * @param error - A caught value of unknown type.
 * @returns The carried diagnostics, or an empty list when the value is not a Holqa error.
 */
export function diagnosticsOf(error: unknown): readonly Diagnostic[] {
  if (typeof error !== "object" || error === null || !("diagnostics" in error) || !Array.isArray(error.diagnostics))
    return [];
  const diagnostics: readonly unknown[] = error.diagnostics;
  return diagnostics.every(isDiagnosticLike) ? diagnostics : [];
}

/**
 * Reports whether a caught value is a Holqa error, from this or any other copy
 * of `@holqa/core`.
 *
 * @param error - A caught value of unknown type.
 * @returns `true` when the value carries at least one diagnostic.
 */
export function isHolqaError(error: unknown): error is HolqaError {
  return error instanceof Error && diagnosticsOf(error).length > 0;
}

/**
 * Checks the minimal diagnostic shape: a string code, severity and message.
 *
 * @param value - A candidate diagnostic.
 * @returns `true` when the value looks like a {@link Diagnostic}.
 */
function isDiagnosticLike(value: unknown): value is Diagnostic {
  return typeof value === "object" && value !== null
    && "code" in value && typeof value.code === "string"
    && "severity" in value && typeof value.severity === "string"
    && "message" in value && typeof value.message === "string";
}