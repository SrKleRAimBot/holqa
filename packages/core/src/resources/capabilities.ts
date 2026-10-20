import type { BindingCapabilities } from "@/binding/runtime-binding";
import type { Diagnostic } from "@/diagnostics/diagnostic";
import type { JsonObject } from "@/json";
import type {
  QueueBackoff,
  QueueCapabilities,
  ResourceKind,
  ResourceKindMap
} from "@/resources/kinds";
import type { ResourceDescriptorOf } from "@/resources/resource-descriptor";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";

/** One requirement a binding cannot satisfy: the capability it needs, in the required-capability vocabulary, and why. */
interface Shortfall {
  readonly requirement: string;
  readonly reason: string;
}

/** Compares one kind's requirements with advertised capabilities and describes every shortfall. */
type RequirementCheck<Kind extends ResourceKind> = (requirements: ResourceKindMap[Kind]["requirements"], capabilities: ResourceKindMap[Kind]["capabilities"]) => Shortfall[];

/**
 * One comparison per resource kind. The mapped type makes adding a kind
 * without deciding how its requirements are checked a compile error.
 */
const requirementChecks: { readonly [Kind in ResourceKind]: RequirementCheck<Kind> } = {
  "queue": (requirements, capabilities) => [
    ...capabilities.delivery.includes(requirements.delivery) ? [] : [{ requirement: `queue.delivery.${requirements.delivery}`, reason: `${requirements.delivery} delivery is required` }],
    ...requirements.maxAttempts === undefined || requirements.maxAttempts <= capabilities.maxAttempts
      ? []
      : [{ requirement: "queue.max-attempts", reason: `${requirements.maxAttempts} delivery attempts are required but at most ${capabilities.maxAttempts} are supported` }],
    ...!requirements.deadLetter || capabilities.deadLetter ? [] : [{ requirement: "queue.dead-letter", reason: "a dead-letter destination is required" }],
    ...backoffShortfalls(requirements.backoff, capabilities)
  ],
  "bucket": (requirements, capabilities) => capabilities.access.includes(requirements.access) ? [] : [{ requirement: `bucket.access.${requirements.access}`, reason: `${requirements.access} access is required` }],
  "schedule": (requirements, capabilities) => capabilities.overlap.includes(requirements.overlap) ? [] : [{ requirement: `schedule.overlap.${requirements.overlap}`, reason: `the "${requirements.overlap}" overlap policy is required` }],
  "http.api": () => [],
  "static.site": (requirements, capabilities) => !requirements.spaFallback || capabilities.spaFallback ? [] : [{ requirement: "static.site.spa-fallback", reason: "single-page application fallback is required" }]
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
 * @returns One `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic per shortfall, whose `details` name the
 * `resource`, `kind`, `binding` and `requirement` (in the required-capability vocabulary); empty when the binding satisfies the resource.
 */
export function checkCapabilities<Kind extends ResourceKind>(resource: ResourceDescriptorOf<Kind>, advertised: BindingCapabilities, bindingName: string): readonly Diagnostic[] {
  const capabilities = advertised[resource.kind] as ResourceKindMap[Kind]["capabilities"] | undefined;
  if (capabilities === undefined)
    return [unsupported(`Binding "${bindingName}" does not support ${resource.kind} resources, required by "${resource.id}".`, { resource: resource.id, kind: resource.kind, binding: bindingName, requirement: resource.kind })];
  const check = requirementChecks[resource.kind] as RequirementCheck<Kind>;
  return check(resource.requirements, capabilities)
    .map(shortfall => unsupported(`Binding "${bindingName}" cannot satisfy ${resource.kind} "${resource.id}": ${shortfall.reason}.`, { resource: resource.id, kind: resource.kind, binding: bindingName, requirement: shortfall.requirement }));
}

/**
 * Describes why a binding cannot apply a queue's declared backoff: an
 * unsupported strategy, or a delay longer than the binding can schedule.
 *
 * @param backoff - The declared backoff, if any.
 * @param capabilities - The binding's queue capabilities.
 * @returns One shortfall per problem; empty when the backoff is absent or supported.
 */
function backoffShortfalls(backoff: QueueBackoff | undefined, capabilities: QueueCapabilities): Shortfall[] {
  if (backoff === undefined)
    return [];
  if (!(capabilities.backoff ?? []).includes(backoff.strategy))
    return [{ requirement: `queue.backoff.${backoff.strategy}`, reason: `${backoff.strategy} backoff is required` }];
  const longest = backoff.strategy === "fixed" ? backoff.delaySeconds : backoff.maxDelaySeconds;
  const supported = capabilities.maxDelaySeconds ?? 0;
  return longest <= supported ? [] : [{ requirement: "queue.delay", reason: `redelivery delays of ${longest} seconds are required but at most ${supported} are supported` }];
}

/**
 * Builds a capability diagnostic.
 *
 * @param message - The description of the shortfall.
 * @param details - The resource, kind, binding and requirement.
 * @returns An error-severity `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic.
 */
function unsupported(message: string, details: JsonObject): Diagnostic {
  return createDiagnostic({
    code: diagnosticCodes.bindingCapabilityUnsupported,
    severity: "error",
    message,
    details,
    hint: "Choose a binding that supports the requirement, or change the declaration deliberately. Holqa never weakens a declared requirement."
  });
}