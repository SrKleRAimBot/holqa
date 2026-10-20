import type { BindingReport } from "@holqa/bindings";

import type {
  Diagnostic,
  DiagnosticLocation
} from "@holqa/core";

import type { AnalysisOutcome } from "@/analysis/host";

import { bindingReportFormat } from "@holqa/bindings";
import {
  hasErrors,
  validateEntrypoints,
  validateEventAnalysis,
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
  /** The event dependency graph and its cycles, present only when `ok` is `true`. */
  readonly events?: unknown;
  /** The resolved binding configuration, present only when `ok` is `true` and a bindings module was given. */
  readonly bindings?: unknown;
  readonly diagnostics: readonly Diagnostic[];
}

/** Every registered diagnostic code, for checking codes received from another process. */
const knownCodes: ReadonlySet<string> = new Set(Object.values(diagnosticCodes));

/**
 * Reads the report an analysis process sent. The process ran application
 * code, so its output is untrusted: the report must be well-formed JSON,
 * every diagnostic must use a registered code, and the manifest, entry
 * point map and event analysis must pass the compiler's validators.
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
  let bindings: BindingReport | undefined;
  if ("bindings" in report && report.bindings !== undefined) {
    bindings = readBindingReport(report.bindings);
    if (bindings === undefined)
      return malformed(`The analysis process sent a binding report that is not in the ${bindingReportFormat} format.`, output);
  }
  const extra = bindings === undefined ? {} : { bindings };
  if (!("events" in report) || report.events === undefined)
    return { ok: true, manifest: manifest.value, entrypoints: entrypoints.value, diagnostics, output, ...extra };
  const events = validateEventAnalysis(report.events);
  if (!events.ok)
    return { ok: false, diagnostics: events.error, output };
  return { ok: true, manifest: manifest.value, entrypoints: entrypoints.value, events: events.value, diagnostics, output, ...extra };
}

/**
 * Checks a binding report received from the analysis process, which ran
 * application and provider code: it must be plain JSON in the binding report
 * format, with lists where lists belong and only registered diagnostic codes.
 *
 * @param value - The received report.
 * @returns The report, or `undefined` when it cannot be trusted.
 */
function readBindingReport(value: unknown): BindingReport | undefined {
  if (!isJsonValue(value) || typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const candidate = value as { readonly format?: unknown; readonly name?: unknown; readonly application?: unknown; readonly resources?: unknown; readonly services?: unknown; readonly providers?: unknown; readonly diagnostics?: unknown };
  if (candidate.format !== bindingReportFormat || typeof candidate.name !== "string" || typeof candidate.application !== "string")
    return undefined;
  if (!Array.isArray(candidate.resources) || !Array.isArray(candidate.services) || !Array.isArray(candidate.providers) || !Array.isArray(candidate.diagnostics))
    return undefined;
  const diagnostics = (candidate.diagnostics as readonly unknown[]).map(readDiagnostic);
  if (diagnostics.includes(undefined))
    return undefined;
  const wellFormed = (candidate.resources as readonly unknown[]).every(isResourceReport)
    && (candidate.services as readonly unknown[]).every(isServiceReport)
    && (candidate.providers as readonly unknown[]).every(isProviderReport);
  return wellFormed ? { ...value, diagnostics } as unknown as BindingReport : undefined;
}

/** A JSON object whose fields are read by name. */
type Fields = Readonly<Record<string, unknown>>;

/**
 * Reports whether a value is a JSON object.
 *
 * @param value - The candidate.
 * @returns `true` for a non-array object.
 */
function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reports whether a value is a list of strings.
 *
 * @param value - The candidate.
 * @returns `true` for an array whose elements are all strings.
 */
function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

/**
 * Checks one resource entry of a binding report: the fields the CLI reads.
 *
 * @param value - The entry.
 * @returns `true` when it has an identifier, kind, provider, selection and well-formed requirements.
 */
function isResourceReport(value: unknown): boolean {
  if (!isObject(value))
    return false;
  const { id, kind, provider, selection, requirements } = value;
  return typeof id === "string" && typeof kind === "string" && typeof provider === "string" && typeof selection === "string"
    && Array.isArray(requirements) && requirements.every((requirement: unknown) => {
    const { capability, support } = isObject(requirement) ? requirement : {};
    return typeof capability === "string" && typeof support === "string";
  });
}

/**
 * Checks one service entry of a binding report.
 *
 * @param value - The entry.
 * @returns `true` when it names its service, providers and selection.
 */
function isServiceReport(value: unknown): boolean {
  const { service, providers, selection } = isObject(value) ? value : {};
  return typeof service === "string" && isStringList(providers) && typeof selection === "string";
}

/**
 * Checks one provider entry of a binding report: everything the binding
 * output formats, so a malformed report is rejected here instead of failing
 * while it is printed.
 *
 * @param value - The entry.
 * @returns `true` for a well-formed provider entry.
 */
function isProviderReport(value: unknown): boolean {
  if (!isObject(value))
    return false;
  const { name, provider, role, contracts, credentials, emulations, topology } = value;
  return typeof name === "string" && typeof provider === "string" && typeof role === "string"
    && isObject(contracts) && Object.values(contracts).every(version => typeof version === "number")
    && isStringList(credentials)
    && Array.isArray(emulations) && emulations.every((emulation: unknown) => {
    const { capability, mechanism, requires } = isObject(emulation) ? emulation : {};
    return typeof capability === "string" && typeof mechanism === "string" && (requires === undefined || isStringList(requires));
  })
  && isObject(topology) && (({ connectors }) => connectors === undefined || isStringList(connectors))(topology);
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