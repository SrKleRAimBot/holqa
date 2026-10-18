import type { BindingCapabilities } from "@/binding/runtime-binding";
import type { Diagnostic } from "@/diagnostics/diagnostic";
import type {
  ResourceKind,
  ResourceKindMap
} from "@/resources/kinds";
import type { ResourceDescriptorOf } from "@/resources/resource-descriptor";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";

/** Compares one kind's requirements with advertised capabilities and describes every shortfall. */
type RequirementCheck<Kind extends ResourceKind> = (requirements: ResourceKindMap[Kind]["requirements"], capabilities: ResourceKindMap[Kind]["capabilities"]) => string[];

/**
 * One comparison per resource kind. The mapped type makes adding a kind
 * without deciding how its requirements are checked a compile error.
 */
const requirementChecks: { readonly [Kind in ResourceKind]: RequirementCheck<Kind> } = {
  "queue": (requirements, capabilities) => [
    ...capabilities.delivery.includes(requirements.delivery) ? [] : [`${requirements.delivery} delivery is required`],
    ...requirements.maxAttempts === undefined || requirements.maxAttempts <= capabilities.maxAttempts
      ? []
      : [`${requirements.maxAttempts} delivery attempts are required but at most ${capabilities.maxAttempts} are supported`],
    ...!requirements.deadLetter || capabilities.deadLetter ? [] : ["a dead-letter destination is required"]
  ],
  "bucket": (requirements, capabilities) => capabilities.access.includes(requirements.access) ? [] : [`${requirements.access} access is required`],
  "schedule": (requirements, capabilities) => capabilities.overlap.includes(requirements.overlap) ? [] : [`the "${requirements.overlap}" overlap policy is required`],
  "http.api": () => []
};

/**
 * Compares the behaviour a resource requires with the capabilities a binding
 * advertises. A requirement is never weakened or ignored: every shortfall is
 * reported. A stronger capability than required is accepted.
 *
 * @param resource - The resource whose requirements must be met.
 * @param advertised - Everything the binding advertises, by resource kind. A
 * missing kind means the binding does not support it at all.
 * @param bindingName - The binding's name, for messages.
 * @returns One `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic per shortfall; empty when the binding satisfies the resource.
 */
export function checkCapabilities<Kind extends ResourceKind>(resource: ResourceDescriptorOf<Kind>, advertised: BindingCapabilities, bindingName: string): readonly Diagnostic[] {
  const capabilities = advertised[resource.kind] as ResourceKindMap[Kind]["capabilities"] | undefined;
  if (capabilities === undefined)
    return [unsupported(`Binding "${bindingName}" does not support ${resource.kind} resources, required by "${resource.id}".`)];
  const check = requirementChecks[resource.kind] as RequirementCheck<Kind>;
  return check(resource.requirements, capabilities)
    .map(shortfall => unsupported(`Binding "${bindingName}" cannot satisfy ${resource.kind} "${resource.id}": ${shortfall}.`));
}

/**
 * Builds a capability diagnostic.
 *
 * @param message - The description of the shortfall.
 * @returns An error-severity `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic.
 */
function unsupported(message: string): Diagnostic {
  return createDiagnostic({
    code: diagnosticCodes.bindingCapabilityUnsupported,
    severity: "error",
    message,
    hint: "Choose a binding that supports the requirement, or change the declaration deliberately. Holqa never weakens a declared requirement."
  });
}