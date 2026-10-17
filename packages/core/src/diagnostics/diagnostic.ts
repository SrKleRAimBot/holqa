import type { DiagnosticCode } from "@/diagnostics/codes";

/**
 * How serious a diagnostic is. `error` diagnostics must fail the operation
 * that produced them; `warning` and `info` diagnostics must not.
 */
export type DiagnosticSeverity = "error" | "warning" | "info";

/**
 * A source position that a diagnostic refers to. Lines and columns are 1-based.
 */
export interface DiagnosticLocation {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * A structured, machine-readable problem report.
 *
 * Diagnostics are plain JSON-compatible data so that they can be printed for
 * humans, emitted as JSON for agents, and compared deterministically in tests.
 */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly location?: DiagnosticLocation;
  /** Optional, actionable guidance for resolving the problem. */
  readonly hint?: string;
}

/**
 * Creates an immutable {@link Diagnostic}, omitting optional fields that were not supplied.
 *
 * Omitting (rather than setting to `undefined`) keeps serialized output stable
 * and compatible with `exactOptionalPropertyTypes`.
 *
 * @param input - The diagnostic fields.
 * @returns A frozen diagnostic object.
 *
 * @example
 * ```ts
 * const diagnostic = createDiagnostic({
 *   code: diagnosticCodes.resourceIdInvalid,
 *   severity: "error",
 *   message: "Resource identifier \"Orders\" must be lowercase."
 * });
 * ```
 */
export function createDiagnostic(input: Diagnostic): Diagnostic {
  const diagnostic: Diagnostic = {
    code: input.code,
    severity: input.severity,
    message: input.message,
    ...(input.location === undefined ? {} : { location: Object.freeze({ ...input.location }) }),
    ...(input.hint === undefined ? {} : { hint: input.hint })
  };
  return Object.freeze(diagnostic);
}

/**
 * Renders a diagnostic as a single human-readable line, followed by an
 * indented hint line when a hint is present.
 *
 * The format is `<file>:<line>:<column> <severity> <code>: <message>`, with the
 * location prefix omitted when the diagnostic has no location.
 *
 * @param diagnostic - The diagnostic to render.
 * @returns The formatted text without a trailing newline.
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.location === undefined ? "" : `${formatLocation(diagnostic.location)} `;
  const headline = `${location}${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`;
  return diagnostic.hint === undefined ? headline : `${headline}\n  hint: ${diagnostic.hint}`;
}

/**
 * Renders a location as `file`, `file:line`, or `file:line:column`, depending on
 * which positional fields are present.
 *
 * @param location - The location to render.
 * @returns The compact location string.
 */
function formatLocation(location: DiagnosticLocation): string {
  if (location.line === undefined)
    return location.file;
  return location.column === undefined
    ? `${location.file}:${location.line}`
    : `${location.file}:${location.line}:${location.column}`;
}