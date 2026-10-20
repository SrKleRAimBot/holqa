import type { DiagnosticCode } from "@/diagnostics/codes";
import type { Diagnostic } from "@/diagnostics/diagnostic";
import type { JsonObject } from "@/json";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";

/**
 * Why a binding cannot be used. Each kind has its own diagnostic code, so a
 * tool can decide what to do without parsing messages: only `unavailable` is
 * transient, every other kind needs a change before retrying can help.
 *
 * - `configuration`: the binding's settings are malformed or contradictory.
 * - `credentials-missing`: a credential the binding needs is not set.
 * - `credentials-invalid`: infrastructure rejected the binding's credentials.
 * - `capability`: the binding cannot satisfy a declared requirement.
 * - `version`: the provider implements a contract version Holqa does not.
 * - `unavailable`: infrastructure is temporarily unreachable.
 * - `failed`: infrastructure failed permanently, for example a missing queue.
 */
export type BindingFailureKind = "configuration" | "credentials-missing" | "credentials-invalid" | "capability" | "version" | "unavailable" | "failed";

/** The diagnostic code of each binding failure kind. */
export const bindingFailureCodes: { readonly [Kind in BindingFailureKind]: DiagnosticCode } = Object.freeze({
  "configuration": diagnosticCodes.bindingConfigInvalid,
  "credentials-missing": diagnosticCodes.bindingCredentialsMissing,
  "credentials-invalid": diagnosticCodes.bindingCredentialsInvalid,
  "capability": diagnosticCodes.bindingCapabilityUnsupported,
  "version": diagnosticCodes.bindingContractIncompatible,
  "unavailable": diagnosticCodes.bindingUnavailable,
  "failed": diagnosticCodes.bindingFailed
});

/** Settings of {@link bindingFailure}. */
export interface BindingFailureInit {
  /** The name of the binding or provider that failed, for example `rabbitmq`. */
  readonly binding: string;
  /** What went wrong, safe to show operators. Must never contain credentials or secret values. */
  readonly message: string;
  readonly hint?: string;
  /** More operator-safe details. `binding`, `failure` and `transient` are always added. */
  readonly details?: JsonObject;
}

/**
 * Builds the diagnostic for a binding failure. Its `details` always name
 * the binding, the failure kind and whether retrying may help (`transient`),
 * so tools and agents can react without parsing the message.
 *
 * @example
 * ```ts
 * throw new HolqaError(bindingFailure("unavailable", { binding: "rabbitmq", message: "The broker refused the connection." }));
 * ```
 *
 * @param kind - Why the binding cannot be used.
 * @param init - The binding, message, hint and details.
 * @returns An error diagnostic with the kind's code.
 */
export function bindingFailure(kind: BindingFailureKind, init: BindingFailureInit): Diagnostic {
  return createDiagnostic({
    code: bindingFailureCodes[kind],
    severity: "error",
    message: init.message,
    ...init.hint === undefined ? {} : { hint: init.hint },
    details: { ...init.details, binding: init.binding, failure: kind, transient: kind === "unavailable" }
  });
}

/**
 * Reports whether a diagnostic describes a binding failure that may go away
 * on its own, so that retrying later is reasonable. Every other binding
 * failure needs a change to configuration, credentials or infrastructure.
 *
 * @param diagnostic - A diagnostic, typically from a failed binding start.
 * @returns `true` for `HOLQA_BINDING_UNAVAILABLE`.
 */
export function isTransientBindingFailure(diagnostic: Diagnostic): boolean {
  return diagnostic.code === diagnosticCodes.bindingUnavailable;
}