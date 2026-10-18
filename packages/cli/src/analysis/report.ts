import type {
  Diagnostic,
  DiagnosticLocation
} from "@holqa/core";

import type { AnalysisOutcome } from "@/analysis/host";

import {
  hasErrors,
  validateEntrypoints,
  validateManifest
} from "@holqa/compiler";
import {
  createDiagnostic,
  diagnosticCodes,
  isJsonValue
} from "@holqa/core";

/** The format tag of the message an analysis process sends back. */
export const analysisReportFormat = "holqa.analysis-report/1";

/** What an analysis process sends back: JSON data only. */
export interface AnalysisReport {
  readonly format: typeof analysisReportFormat;
  readonly ok: boolean;
  /** The manifest, present only when `ok` is `true`. */
  readonly manifest?: unknown;
  /** The entry point map, present only when `ok` is `true`. */
  readonly entrypoints?: unknown;
  readonly diagnostics: readonly Diagnostic[];
}

/** Every registered diagnostic code, for checking codes received from another process. */
const knownCodes: ReadonlySet<string> = new Set(Object.values(diagnosticCodes));

/**
 * Reads the report an analysis process sent. The process ran application
 * code, so its output is untrusted: the report must be well-formed JSON,
 * every diagnostic must use a registered code, and the manifest and entry
 * point map must pass the compiler's validators.
 *
 * @param text - The raw message.
 * @param output - What the process printed, attached to the outcome.
 * @returns The outcome, or a `HOLQA_ANALYSIS_FAILED` / `HOLQA_MANIFEST_INVALID` failure when the report cannot be trusted.
 */
export async function readAnalysisReport(text: string, output: string): Promise<AnalysisOutcome> {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return malformed("The analysis process sent a report that is not JSON.", output);
  }
  if (typeof report !== "object" || report === null || !("format" in report) || report.format !== analysisReportFormat || !("ok" in report) || typeof report.ok !== "boolean" || !("diagnostics" in report) || !Array.isArray(report.diagnostics))
    return malformed(`The analysis process sent a report that is not in the ${analysisReportFormat} format.`, output);
  const diagnostics: Diagnostic[] = [];
  for (const entry of report.diagnostics as readonly unknown[]) {
    const diagnostic = readDiagnostic(entry);
    if (diagnostic === undefined)
      return malformed("The analysis process sent a malformed diagnostic.", output);
    diagnostics.push(diagnostic);
  }
  if (!report.ok || hasErrors(diagnostics))
    return { ok: false, diagnostics: hasErrors(diagnostics) ? diagnostics : [...diagnostics, failure("The analysis process reported failure without an error diagnostic.")], output };

  const manifest = validateManifest("manifest" in report ? report.manifest : undefined);
  if (!manifest.ok)
    return { ok: false, diagnostics: manifest.error, output };
  const entrypoints = await validateEntrypoints("entrypoints" in report ? report.entrypoints : undefined, manifest.value);
  if (!entrypoints.ok)
    return { ok: false, diagnostics: entrypoints.error, output };
  return { ok: true, manifest: manifest.value, entrypoints: entrypoints.value, diagnostics, output };
}

/**
 * Builds a failure for a report that cannot be trusted.
 *
 * @param message - What is wrong with the report.
 * @param output - What the process printed.
 * @returns A failed outcome with one `HOLQA_ANALYSIS_FAILED` diagnostic.
 */
function malformed(message: string, output: string): AnalysisOutcome {
  return { ok: false, diagnostics: [failure(message)], output };
}

/**
 * Builds a `HOLQA_ANALYSIS_FAILED` error.
 *
 * @param message - What went wrong.
 * @returns The diagnostic.
 */
function failure(message: string): Diagnostic {
  return createDiagnostic({ code: diagnosticCodes.analysisFailed, severity: "error", message });
}

/**
 * Checks and copies one diagnostic received from another process.
 *
 * @param value - A candidate diagnostic from the parsed report.
 * @returns A frozen diagnostic, or `undefined` when the value is not a well-formed diagnostic with a registered code.
 */
export function readDiagnostic(value: unknown): Diagnostic | undefined {
  if (typeof value !== "object" || value === null)
    return undefined;
  const { code, severity, message, location, hint, details } = value as Record<string, unknown>;
  if (typeof code !== "string" || !knownCodes.has(code) || (severity !== "error" && severity !== "warning" && severity !== "info") || typeof message !== "string")
    return undefined;
  if (hint !== undefined && typeof hint !== "string")
    return undefined;
  if (details !== undefined && (typeof details !== "object" || details === null || Array.isArray(details) || !isJsonValue(details)))
    return undefined;
  const readLocation = location === undefined ? undefined : readDiagnosticLocation(location);
  if (location !== undefined && readLocation === undefined)
    return undefined;
  return createDiagnostic({
    code: code as Diagnostic["code"],
    severity,
    message,
    ...(readLocation === undefined ? {} : { location: readLocation }),
    ...(hint === undefined ? {} : { hint }),
    ...(details === undefined ? {} : { details: details as Diagnostic["details"] & object })
  });
}

/**
 * Checks a diagnostic location received from another process.
 *
 * @param value - A candidate location.
 * @returns The location, or `undefined` when it is malformed.
 */
function readDiagnosticLocation(value: unknown): DiagnosticLocation | undefined {
  if (typeof value !== "object" || value === null)
    return undefined;
  const { file, line, column } = value as Record<string, unknown>;
  /**
   * Checks an optional 1-based line or column number.
   *
   * @param candidate - The received value.
   * @returns `true` when it is absent or a positive safe integer.
   */
  const position = (candidate: unknown): boolean => candidate === undefined || (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 1);
  if (typeof file !== "string" || !position(line) || !position(column))
    return undefined;
  return { file, ...(typeof line === "number" ? { line } : {}), ...(typeof column === "number" ? { column } : {}) };
}