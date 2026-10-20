import type {
  ResourceKind,
  ResourceKindMap
} from "@/resources/kinds";

// The required-capability vocabulary names what a resource needs from its
// binding as dot-separated strings. The compiler records it in manifests
// (`requiredCapabilities`), capability diagnostics name the unmet one in
// `details.requirement`, and binding inspection reports whether each is met
// natively or through an emulation. Changing these strings changes manifest
// bytes, so they only ever grow.

/** The settings a capability derivation reads: a resource's kind and requirements. */
export type CapabilitySubject = { [Kind in ResourceKind]: { readonly kind: Kind; readonly requirements: ResourceKindMap[Kind]["requirements"] } }[ResourceKind];

/**
 * Lists the capabilities a resource requires from its binding, in the
 * required-capability vocabulary: the kind itself, then one entry per
 * declared requirement (for example `queue.dead-letter` or
 * `queue.backoff.exponential`).
 *
 * @param resource - A resource descriptor or manifest resource.
 * @returns The required capabilities, in a stable order.
 *
 * @example
 * ```ts
 * requiredCapabilities({ kind: "bucket", requirements: { access: "private" } }); // ["bucket", "bucket.access.private"]
 * ```
 */
export function requiredCapabilities(resource: CapabilitySubject): string[] {
  switch (resource.kind) {
    case "queue": {
      const { delivery, deadLetter, maxAttempts, backoff } = resource.requirements;
      return [
        "queue",
        `queue.delivery.${delivery}`,
        ...deadLetter ? ["queue.dead-letter"] : [],
        ...maxAttempts === undefined ? [] : ["queue.max-attempts"],
        ...backoff === undefined ? [] : [`queue.backoff.${backoff.strategy}`]
      ];
    }
    case "bucket":
      return ["bucket", `bucket.access.${resource.requirements.access}`];
    case "schedule":
      return ["schedule", `schedule.overlap.${resource.requirements.overlap}`];
    case "http.api":
      return ["http.api"];
    default: {
      const unknown: never = resource;
      return [String((unknown as { readonly kind?: unknown }).kind)];
    }
  }
}

/**
 * Lists what a binding advertises for one resource kind, in the same
 * vocabulary, so inspection can show both sides side by side. Quantities
 * (maximum attempts, delays, sizes) are reported by inspection separately.
 *
 * @param kind - The resource kind.
 * @param capabilities - What the binding advertises for it.
 * @returns The provided capabilities, sorted.
 */
export function providedCapabilities<Kind extends ResourceKind>(kind: Kind, capabilities: ResourceKindMap[Kind]["capabilities"]): string[] {
  const provided = [kind as string];
  switch (kind) {
    case "queue": {
      const queue = capabilities as ResourceKindMap["queue"]["capabilities"];
      provided.push(...queue.delivery.map(delivery => `queue.delivery.${delivery}`), "queue.max-attempts");
      if (queue.deadLetter)
        provided.push("queue.dead-letter");
      provided.push(...(queue.backoff ?? []).map(strategy => `queue.backoff.${strategy}`));
      if ((queue.maxDelaySeconds ?? 0) > 0)
        provided.push("queue.delay");
      break;
    }
    case "bucket": {
      const bucket = capabilities as ResourceKindMap["bucket"]["capabilities"];
      provided.push(...bucket.access.map(access => `bucket.access.${access}`), ...(bucket.events ?? []).map(event => `trigger.bucket.${event.replace(".", "-")}`));
      if (bucket.signedUrls !== undefined)
        provided.push("bucket.signed-urls");
      break;
    }
    case "schedule":
      provided.push(...(capabilities as ResourceKindMap["schedule"]["capabilities"]).overlap.map(overlap => `schedule.overlap.${overlap}`));
      break;
    default:
      break;
  }
  return [...new Set(provided)].sort();
}