import type { Diagnostic } from "@/diagnostics/diagnostic";
import type { ValidationIssue } from "@/schema/validate-input";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";
import {
  diagnosticsOf,
  HolqaError
} from "@/errors/holqa-error";

/**
 * The error object Holqa sends to HTTP and RPC callers. It never contains
 * stack traces, handler error messages, secret values or the rejected input:
 * only the diagnostic code, a message safe to show, the invocation identifier
 * for correlating with server logs, and per-field validation issues.
 */
export interface HttpErrorDetail {
  /** The diagnostic code, for example `HOLQA_INPUT_INVALID`. Match on this, not on `message`. */
  readonly code: string;
  readonly message: string;
  /** The invocation that failed, also present in the server's structured logs. Absent when no invocation started (for example an unknown route). */
  readonly invocationId?: string;
  /** Per-field problems, present for `HOLQA_INPUT_INVALID`. */
  readonly issues?: readonly ValidationIssue[];
}

/** The JSON body of an HTTP route error response: `{ "error": { ... } }`. */
export interface HttpErrorBody {
  readonly error: HttpErrorDetail;
}

/** Optional settings of an {@link HttpRejectedError}. */
export interface HttpRejectedErrorInit {
  /** Headers to add to the error response, for example `www-authenticate`. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The Holqa error that caused the rejection, for example the
   * `InputValidationError` of a request body. Its diagnostics and validation
   * issues replace the `HOLQA_HTTP_REJECTED` diagnostic, so callers see the
   * original code.
   */
  readonly cause?: unknown;
}

/** Statuses an {@link HttpRejectedError} may carry: client and server error statuses. */
const rejectionStatus = /^[45]\d\d$/;

/** An HTTP header name: an RFC 9110 token. */
const headerName = /^[!#$%&'*+.^`|~\w-]+$/;

/** An HTTP header value without line breaks or NUL, which would let a value inject other headers. */
const headerValue = /^[^\r\n\0]*$/;

/**
 * Thrown by middleware or a handler to reject a request with an explicit HTTP
 * status and a message that is safe to show to the caller, for example `401`
 * from an authentication middleware. The runtime turns it into an error
 * response in the transport's format (a route error body, or an RPC failure
 * envelope). Other errors become `500` responses whose details are only logged.
 *
 * @example
 * ```ts
 * if (token === null)
 *   throw new HttpRejectedError(401, "Sign in to continue.", { headers: { "www-authenticate": "Bearer" } });
 * ```
 */
export class HttpRejectedError extends HolqaError {
  /** The HTTP status to respond with: 400–599. */
  readonly status: number;

  /** Headers added to the error response. */
  readonly headers: Readonly<Record<string, string>>;

  /** Per-field problems copied from a validation error cause; empty otherwise. */
  readonly issues: readonly ValidationIssue[];

  /**
   * Creates a rejection.
   *
   * @param status - A client or server error status, 400–599.
   * @param message - The message sent to the caller when there is no Holqa error `cause`. Must not contain secrets or internal details.
   * @param init - Response headers, and the Holqa error that caused the rejection.
   * @throws {RangeError} When `status` is not an integer between 400 and 599, or a header name or value is invalid.
   */
  constructor(status: number, message: string, init: HttpRejectedErrorInit = {}) {
    if (!Number.isInteger(status) || !rejectionStatus.test(String(status)))
      throw new RangeError(`HttpRejectedError requires a status between 400 and 599, got ${String(status)}.`);
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (!headerName.test(name) || typeof value !== "string" || !headerValue.test(value))
        throw new RangeError(`HttpRejectedError received an invalid header "${name}".`);
    }
    const causes: readonly Diagnostic[] = diagnosticsOf(init.cause);
    super(causes.length > 0 ? causes : createDiagnostic({ code: diagnosticCodes.httpRejected, severity: "error", message, details: { status } }), init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "HttpRejectedError";
    this.status = status;
    this.headers = Object.freeze({ ...init.headers });
    this.issues = Object.freeze([...issuesOf(init.cause)]);
  }
}

/**
 * Recognizes an {@link HttpRejectedError} from this or any other copy of `@holqa/core`.
 *
 * @param error - A caught value of unknown type.
 * @returns `true` for a Holqa error named `HttpRejectedError` with an error status (400–599), a `headers` record of strings and an `issues` list.
 */
export function isHttpRejectedError(error: unknown): error is HttpRejectedError {
  if (error instanceof HttpRejectedError)
    return true;
  return error instanceof Error && error.name === "HttpRejectedError" && diagnosticsOf(error).length > 0
    && "status" in error && typeof error.status === "number" && Number.isInteger(error.status) && rejectionStatus.test(String(error.status))
    && "headers" in error && typeof error.headers === "object" && error.headers !== null && Object.entries(error.headers).every(([name, value]) => headerName.test(name) && typeof value === "string" && headerValue.test(value))
    && "issues" in error && Array.isArray(error.issues);
}

/**
 * Reads the validation issues of a caught error, recognized by shape.
 *
 * @param error - A caught value, typically an `InputValidationError`.
 * @returns Its issues, or an empty list.
 */
function issuesOf(error: unknown): readonly ValidationIssue[] {
  if (typeof error !== "object" || error === null || !("issues" in error) || !Array.isArray(error.issues))
    return [];
  return error.issues as readonly ValidationIssue[];
}