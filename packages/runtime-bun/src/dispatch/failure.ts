import type {
  Diagnostic,
  DiagnosticCode,
  ValidationIssue
} from "@holqa/core";

import {
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf,
  isHttpRejectedError
} from "@holqa/core";

/**
 * A normalized invocation failure. `code`, `message`, `status`, `headers` and
 * `issues` are safe to send to the caller; `diagnostics` and `error` are for
 * logs only and may contain internal details.
 */
export interface InvocationFailure {
  /** The diagnostic code callers see, for example `HOLQA_INPUT_INVALID`. */
  readonly code: DiagnosticCode;
  /** A message safe to show callers. Handler error messages are never used here. */
  readonly message: string;
  /** The HTTP status the failure maps to. Background transports use the code instead. */
  readonly status: number;
  /** Response headers requested by an `HttpRejectedError`, or added by the runtime (such as `allow`). */
  readonly headers: Readonly<Record<string, string>>;
  /** Per-field validation problems, for `HOLQA_INPUT_INVALID`. */
  readonly issues: readonly ValidationIssue[];
  /** Every diagnostic, for logs. */
  readonly diagnostics: readonly Diagnostic[];
  /** The original error, for logs. Absent for failures the runtime produced itself. */
  readonly error?: unknown;
}

/** Why the runtime aborted an invocation's signal. */
export type AbortCause = "timeout" | "cancelled" | "shutdown";

/** The abort reason the runtime uses, so a handler that rethrows it can still be classified. */
export class InvocationAbort extends Error {
  /** Why the invocation was aborted. */
  readonly abortCause: AbortCause;

  /**
   * Creates an abort reason.
   *
   * @param cause - Why the invocation was aborted.
   */
  constructor(cause: AbortCause) {
    super(cause === "timeout" ? "The invocation timed out." : cause === "shutdown" ? "The runtime is stopping." : "The invocation was cancelled by its caller.");
    this.name = "AbortError";
    this.abortCause = cause;
  }
}

/** HTTP statuses of the failures the runtime itself produces. */
const runtimeStatuses: Readonly<Partial<Record<DiagnosticCode, number>>> = {
  [diagnosticCodes.handlerNotFound]: 404,
  [diagnosticCodes.httpRouteNotFound]: 404,
  [diagnosticCodes.httpMethodNotAllowed]: 405,
  [diagnosticCodes.invocationTimeout]: 504,
  [diagnosticCodes.invocationCancelled]: 503,
  [diagnosticCodes.runtimeOverloaded]: 503,
  [diagnosticCodes.runtimeNotRunning]: 503
};

/**
 * Builds a failure the runtime produced itself, such as a timeout or an unknown route.
 *
 * @param code - The diagnostic code.
 * @param message - A message safe to show callers.
 * @param headers - Response headers, such as `allow` for a method mismatch.
 * @param status - The HTTP status; defaults to the status registered for the code, or 500.
 * @returns A frozen failure with a single diagnostic and no original error.
 */
export function runtimeFailure(code: DiagnosticCode, message: string, headers: Readonly<Record<string, string>> = {}, status: number = runtimeStatuses[code] ?? 500): InvocationFailure {
  return Object.freeze({
    code,
    message,
    status,
    headers: Object.freeze({ ...headers }),
    issues: Object.freeze([]),
    diagnostics: Object.freeze([createDiagnostic({ code, severity: "error", message })])
  });
}

/**
 * Normalizes anything an invocation threw into a failure:
 *
 * - an `HttpRejectedError` keeps its status, code, message, headers and issues;
 * - an abort caused by the runtime becomes a timeout or cancellation;
 * - `HOLQA_RESPONSE_INVALID` stays a server error with a generic message;
 * - everything else becomes `HOLQA_HANDLER_FAILED` with a generic message.
 *
 * The original error is kept for logs only.
 *
 * @param error - The caught value.
 * @returns The normalized failure.
 */
export function failureFromError(error: unknown): InvocationFailure {
  if (error instanceof InvocationAbort)
    return abortFailure(error.abortCause);
  const diagnostics = diagnosticsOf(error);
  if (isHttpRejectedError(error)) {
    const first = diagnostics[0]!;
    return Object.freeze({ code: first.code, message: first.message, status: error.status, headers: error.headers, issues: error.issues, diagnostics, error });
  }
  if (diagnostics[0]?.code === diagnosticCodes.responseInvalid)
    return Object.freeze({ ...serverFailure(diagnosticCodes.responseInvalid, "The handler produced a response that does not match its contract.", diagnostics), error });
  const failed = createDiagnostic({ code: diagnosticCodes.handlerFailed, severity: "error", message: "The handler failed." });
  return Object.freeze({ ...serverFailure(diagnosticCodes.handlerFailed, "The handler failed. Details were logged with the invocation identifier.", [failed, ...diagnostics]), error });
}

/**
 * Builds the failure of an invocation the runtime aborted.
 *
 * @param cause - Why it was aborted.
 * @returns A timeout or cancellation failure.
 */
export function abortFailure(cause: AbortCause): InvocationFailure {
  return cause === "timeout"
    ? runtimeFailure(diagnosticCodes.invocationTimeout, "The invocation did not finish within its time limit.")
    : runtimeFailure(diagnosticCodes.invocationCancelled, cause === "shutdown" ? "The invocation was cancelled because the runtime is stopping." : "The invocation was cancelled by its caller.");
}

/**
 * Builds a 500 failure with a generic message.
 *
 * @param code - The code callers see.
 * @param message - The generic message.
 * @param diagnostics - The diagnostics, for logs.
 * @returns The failure without its original error.
 */
function serverFailure(code: DiagnosticCode, message: string, diagnostics: readonly Diagnostic[]): InvocationFailure {
  return { code, message, status: 500, headers: Object.freeze({}), issues: Object.freeze([]), diagnostics: Object.freeze([...diagnostics]) };
}