import type { Diagnostic } from "@holqa/core";
import type { ExperimentDiagnostic } from "@holqa/experiment-model";

import {
  errorCode,
  experimentCodes,
  experimentDiagnostic
} from "@holqa/experiment-model";

/** A diagnostic produced by the experimental compiler: a registered core code or an experiment code. */
export type CompilerDiagnostic = Diagnostic | ExperimentDiagnostic;

/**
 * Lists the fields diagnostics are ordered by, most significant first.
 *
 * @param diagnostic - The diagnostic to derive the ordering key from.
 * @returns File, line, column, code and message.
 */
function sortKey(diagnostic: CompilerDiagnostic): readonly (string | number)[] {
  return [diagnostic.location?.file ?? "", diagnostic.location?.line ?? 0, diagnostic.location?.column ?? 0, diagnostic.code, diagnostic.message];
}

/**
 * Orders diagnostics deterministically: by file, then line, column, code and message.
 *
 * @param diagnostics - Diagnostics in collection order.
 * @returns A new, sorted array.
 */
export function sortDiagnostics(diagnostics: readonly CompilerDiagnostic[]): CompilerDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const a = sortKey(left);
    const b = sortKey(right);
    for (let index = 0; index < a.length; index++) {
      const x = a[index]!;
      const y = b[index]!;
      if (x !== y)
        return x < y ? -1 : 1;
    }
    return 0;
  });
}

/**
 * Converts an error thrown while a host evaluated an application or handler
 * module into a diagnostic. Host code (which may use Bun or Node) catches the
 * error; this neutral helper gives every host the same report.
 *
 * @param modulePath - The module path relative to the application root.
 * @param error - The thrown value.
 * @returns A `HOLQA_MODULE_EVALUATION_FAILED` error diagnostic that names the cause's code when it has one.
 */
export function moduleEvaluationFailure(modulePath: string, error: unknown): ExperimentDiagnostic {
  const cause = errorCode(error);
  const detail = error instanceof Error ? error.message : String(error);
  return experimentDiagnostic({
    code: experimentCodes.moduleEvaluationFailed,
    severity: "error",
    message: `Evaluating "${modulePath}" threw${cause === undefined ? "" : ` ${cause}`}: ${detail}`,
    location: { file: modulePath },
    hint: cause === experimentCodes.runtimeNotBound
      ? "Compilation evaluates modules without a runtime. Move resource handle and configuration access out of module top level, for example into the handler or a lazily created client."
      : "Modules discovered by the compiler must be importable without side effects."
  });
}