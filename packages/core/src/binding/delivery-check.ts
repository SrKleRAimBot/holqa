import type { AppDescriptor } from "@/app/app-descriptor";
import type { RuntimeBinding } from "@/binding/runtime-binding";
import type { Diagnostic } from "@/diagnostics/diagnostic";
import type { HandlerDefinition } from "@/handlers/handler-descriptor";
import type { ObjectEventType } from "@/resources/kinds";

import { resourceBindingInfo } from "@/binding/runtime-binding";
import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";
import {
  defaultQueueBackoff,
  longestBackoffDelaySeconds
} from "@/resources/backoff";

/** The parts of a handler definition delivery checks read; a manifest handler has them too. */
export type DeliveredHandler = Pick<HandlerDefinition, "id" | "trigger">;

/** Event types by object trigger kind. */
const objectEventTypeOf = { "bucket.object-created": "object.created", "bucket.object-deleted": "object.deleted" } as const satisfies Record<string, ObjectEventType>;

/**
 * Checks that a binding can deliver every background handler's trigger: it
 * has a source for the trigger's resource kind, advertises the object event
 * type an object handler needs, and can delay redeliveries as long as the
 * runtime's default backoff requires for queues that declare none (declared
 * backoffs are checked by `checkCapabilities`). HTTP triggers need no source.
 *
 * @param app - The application that declares the resources.
 * @param handlers - The handlers' definitions (only `id` and `trigger` are read).
 * @param binding - The binding that would deliver them.
 * @returns One `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic per problem; empty when everything can be delivered.
 */
export function checkTriggerDelivery(app: AppDescriptor, handlers: Iterable<DeliveredHandler>, binding: RuntimeBinding): Diagnostic[] {
  const problems: Diagnostic[] = [];
  const resources = new Map(app.resources.map(resource => [resource.id, resource]));
  /**
   * Records one undeliverable handler.
   *
   * @param definition - The handler.
   * @param reason - Why it cannot be delivered.
   */
  const report = (definition: DeliveredHandler, reason: string): void => {
    const resource = resources.get(definition.trigger.resource.id);
    const name = resource === undefined ? binding.name : resourceBindingInfo(binding, resource).binding;
    problems.push(createDiagnostic({
      code: diagnosticCodes.bindingCapabilityUnsupported,
      severity: "error",
      message: `Binding "${name}" cannot deliver ${definition.trigger.kind} triggers to the handler "${definition.id}": ${reason}.`,
      hint: "Use a binding that delivers this trigger, such as the local binding from @holqa/local, or run such handlers through runtime.invoke only (manualTriggers).",
      details: { handler: definition.id, trigger: definition.trigger.kind, binding: name, requirement: `trigger.${definition.trigger.kind}` }
    }));
  };
  for (const definition of handlers) {
    switch (definition.trigger.kind) {
      case "http.route":
      case "http.procedure":
        break;
      case "queue.message": {
        if (binding.sources?.queue === undefined) {
          report(definition, "it has no queue source");
          break;
        }
        const queue = resources.get(definition.trigger.resource.id);
        const supported = (queue === undefined ? binding.capabilities : resourceBindingInfo(binding, queue).capabilities).queue?.maxDelaySeconds ?? 0;
        const needed = longestBackoffDelaySeconds(defaultQueueBackoff);
        if (queue?.kind === "queue" && queue.requirements.backoff === undefined && supported < needed)
          report(definition, `the default backoff delays redeliveries by up to ${needed} seconds but the binding supports at most ${supported}; declare a backoff it supports`);
        break;
      }
      case "bucket.object-created":
      case "bucket.object-deleted": {
        const bucket = resources.get(definition.trigger.resource.id);
        const capabilities = bucket === undefined ? binding.capabilities : resourceBindingInfo(binding, bucket).capabilities;
        if (binding.sources?.bucket === undefined)
          report(definition, "it has no bucket source");
        else if (!(capabilities.bucket?.events ?? []).includes(objectEventTypeOf[definition.trigger.kind]))
          report(definition, `it does not deliver ${objectEventTypeOf[definition.trigger.kind]} events`);
        break;
      }
      case "schedule.tick":
        if (binding.sources?.schedule === undefined)
          report(definition, "it has no schedule source");
        break;
      default: {
        const unknown: never = definition.trigger;
        report(definition, `the trigger kind ${String((unknown as { readonly kind?: unknown }).kind)} has no delivery check`);
      }
    }
  }
  return problems;
}