import type {
  DiagnosticLocation,
  DiagnosticSeverity
} from "@holqa/core";

/**
 * Diagnostic codes used only by the M0 experiments. They follow the planned
 * names in docs/reference/diagnostic-codes.md where one exists. None of them is
 * registered in `@holqa/core`; adding them there is a separate, deliberate
 * public-contract change.
 */
export const experimentCodes = {
  /** A resource identifier is used by more than one resource. */
  resourceIdDuplicate: "HOLQA_RESOURCE_ID_DUPLICATE",
  /** A handler or reference names a resource that is not declared. */
  resourceNotFound: "HOLQA_RESOURCE_NOT_FOUND",
  /** Two handlers share an identifier. */
  handlerIdDuplicate: "HOLQA_HANDLER_ID_DUPLICATE",
  /** More than one consumer is registered for a queue. */
  queueConsumerDuplicate: "HOLQA_QUEUE_CONSUMER_DUPLICATE",
  /** Two HTTP routes match the same request. */
  routeAmbiguous: "HOLQA_ROUTE_AMBIGUOUS",
  /** A schema cannot be safely normalized into the portable representation. */
  schemaUnsupported: "HOLQA_SCHEMA_UNSUPPORTED",
  /** A schema was normalized by a generic converter that cannot prove it is lossless. */
  schemaFidelityUnverified: "HOLQA_SCHEMA_FIDELITY_UNVERIFIED",
  /** Input failed schema validation at a trust boundary. */
  inputInvalid: "HOLQA_INPUT_INVALID",
  /** A resource handle or configuration value was used without a runtime binding. */
  runtimeNotBound: "HOLQA_RUNTIME_NOT_BOUND",
  /** A configuration value failed validation or is missing. */
  configInvalid: "HOLQA_CONFIG_INVALID",
  /** A declaration is malformed (for example an invalid route path or a resource shared by two apps). */
  declarationInvalid: "HOLQA_DECLARATION_INVALID",
  /** Loading an application or handler module threw. */
  moduleEvaluationFailed: "HOLQA_MODULE_EVALUATION_FAILED",
  /** An invocation was cancelled before it completed. */
  invocationCancelled: "HOLQA_INVOCATION_CANCELLED",
  /** An invocation targeted a handler that is not registered. */
  handlerNotFound: "HOLQA_HANDLER_NOT_FOUND",
  /** The runtime is disposed or disposing and rejects new work. */
  runtimeDisposed: "HOLQA_RUNTIME_DISPOSED",
  /** A reload failed; the previous generation stays active. */
  reloadFailed: "HOLQA_RELOAD_FAILED"
} as const;

/** Union of the experiment diagnostic code strings. */
export type ExperimentCode = (typeof experimentCodes)[keyof typeof experimentCodes];

/**
 * A diagnostic with the same shape as `@holqa/core`'s `Diagnostic`, but whose
 * code is an experiment code rather than a registered core code.
 */
export interface ExperimentDiagnostic {
  readonly code: ExperimentCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly location?: DiagnosticLocation;
  readonly hint?: string;
}

/**
 * Creates a frozen experiment diagnostic, omitting optional fields that are absent.
 *
 * @param input - The diagnostic fields.
 * @returns A frozen diagnostic.
 */
export function experimentDiagnostic(input: ExperimentDiagnostic): ExperimentDiagnostic {
  return Object.freeze({
    code: input.code,
    severity: input.severity,
    message: input.message,
    ...(input.location === undefined ? {} : { location: Object.freeze({ ...input.location }) }),
    ...(input.hint === undefined ? {} : { hint: input.hint })
  });
}

/** An error that carries a structured diagnostic. */
export class HolqaError extends Error {
  /** The structured problem report; match on `diagnostic.code`, not on the message. */
  readonly diagnostic: ExperimentDiagnostic;

  /**
   * Creates an error whose message is the diagnostic's message.
   *
   * @param diagnostic - The structured problem report.
   * @param options - Standard error options, such as the underlying `cause`.
   */
  constructor(diagnostic: ExperimentDiagnostic, options?: ErrorOptions) {
    super(diagnostic.message, options);
    this.name = "HolqaError";
    this.diagnostic = diagnostic;
  }
}

/**
 * Throws a {@link HolqaError} with an error-severity diagnostic.
 *
 * @param code - The experiment diagnostic code.
 * @param message - A human-readable description.
 * @param hint - Optional actionable guidance.
 * @throws {HolqaError} Always.
 */
export function fail(code: ExperimentCode, message: string, hint?: string): never {
  throw new HolqaError(experimentDiagnostic({ code, severity: "error", message, ...(hint === undefined ? {} : { hint }) }));
}

/**
 * Returns the diagnostic code of a {@link HolqaError}, or `undefined` for any other value.
 *
 * Uses a structural check so that errors created by a second copy of this
 * package are still recognized.
 *
 * @param error - A caught value.
 * @returns The diagnostic code, if any.
 */
export function errorCode(error: unknown): ExperimentCode | undefined {
  if (typeof error !== "object" || error === null || !("diagnostic" in error))
    return undefined;
  const diagnostic: unknown = error.diagnostic;
  if (typeof diagnostic !== "object" || diagnostic === null || !("code" in diagnostic))
    return undefined;
  return typeof diagnostic.code === "string" ? diagnostic.code as ExperimentCode : undefined;
}