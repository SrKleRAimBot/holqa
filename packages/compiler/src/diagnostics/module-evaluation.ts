import type { Diagnostic } from "@holqa/core";

import {
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf
} from "@holqa/core";

/**
 * Converts an error thrown while a host evaluated the application module or a
 * handler module into a diagnostic. Host code (which may use Bun or Node)
 * catches the error; this neutral helper gives every host the same report.
 *
 * The message names the code of a Holqa error, so that, for example, reading
 * configuration at module top level is reported as `HOLQA_RUNTIME_NOT_BOUND`
 * with a hint to make the access lazy. Stack traces are not included.
 *
 * @param modulePath - The module path relative to the application root.
 * @param error - The thrown value.
 * @returns A `HOLQA_MODULE_EVALUATION_FAILED` error diagnostic.
 */
export function moduleEvaluationFailure(modulePath: string, error: unknown): Diagnostic {
  const [first] = diagnosticsOf(error);
  const cause = first?.code;
  const detail = first?.message ?? (error instanceof Error ? error.message : String(error));
  return createDiagnostic({
    code: diagnosticCodes.moduleEvaluationFailed,
    severity: "error",
    message: `Evaluating "${modulePath}" threw${cause === undefined ? "" : ` ${cause}`}: ${detail}`,
    location: { file: modulePath },
    hint: cause === diagnosticCodes.runtimeNotBound
      ? "Compilation evaluates modules without a runtime binding. Move resource operations and configuration reads out of module top level, for example into the handler or a lazily created client."
      : "Modules evaluated by the compiler must be importable without side effects that need a runtime, network or secrets.",
    details: cause === undefined ? { module: modulePath } : { module: modulePath, cause }
  });
}