import type {
  AnyBindingProvider,
  DeliveredHandler,
  Diagnostic
} from "@holqa/core";

import type { ResolvedBindings } from "@/resolve";

import {
  bindingFailure,
  checkCapabilities,
  checkTriggerDelivery,
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

import { createBinding } from "@/create-binding";

/** A handler, as binding validation reads it: its identifier, trigger and, when known, whether it declares idempotency. */
export interface ValidatedHandler extends DeliveredHandler {
  readonly idempotency?: unknown;
}

/** What a deployment will run, for checks that depend on more than the configuration. */
export interface BindingValidationOptions {
  /** The handlers whose triggers must be delivered, for example a manifest's `handlers`. Absent means trigger delivery is not checked. */
  readonly handlers?: Iterable<ValidatedHandler>;
  /** The runtime limits the deployment uses, checked against the execution host's capabilities. */
  readonly limits?: {
    readonly timeoutMs?: number;
    readonly concurrency?: number;
  };
  /** Whether the runtime will enforce `events.maxEventsPerOperation`, which needs an operation budget store. */
  readonly operationBudgets?: boolean;
}

/**
 * Validates a resolved binding configuration without opening any provider:
 * the resolution's own problems, then every resource's requirements against
 * the capabilities of the provider selected for it, the delivery of every
 * handler's trigger, the deployment topology (a provider that delivers no
 * events for a resource with background handlers, a request-driven host with
 * pull-based delivery), the execution host's limits, and the event safety
 * stores handlers need.
 *
 * @param resolved - A resolution from `resolveBindings`.
 * @param options - The handlers, limits and settings of the deployment.
 * @returns Every problem found; the configuration is valid when none has `error` severity.
 */
export function validateBindings(resolved: ResolvedBindings, options: BindingValidationOptions = {}): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [...resolved.diagnostics];
  if (diagnostics.some(diagnostic => diagnostic.severity === "error"))
    return Object.freeze(diagnostics);
  for (const { resource, provider } of resolved.resources)
    diagnostics.push(...checkCapabilities(resource, provider.resources, provider.name));

  const handlers = [...options.handlers ?? []];
  if (options.handlers !== undefined)
    diagnostics.push(...checkTriggerDelivery(resolved.app, handlers, createBinding(resolved)));
  const providers = new Map(resolved.resources.map(selection => [selection.resource.id as string, selection.provider]));
  const host = executionHost(resolved);
  for (const handler of handlers) {
    if (handler.trigger.kind === "http.route" || handler.trigger.kind === "http.procedure")
      continue;
    const provider = providers.get(handler.trigger.resource.id);
    if (provider === undefined)
      continue;
    const delivery = provider.topology?.delivery ?? "none";
    if (delivery === "none")
      diagnostics.push(topology(`The handler "${handler.id}" is triggered by "${handler.trigger.resource.id}", but its provider "${provider.name}" delivers no events.`, { handler: handler.id, resource: handler.trigger.resource.id, binding: provider.name }, "Select a provider that delivers this resource's events, or run the handler through runtime.invoke only."));
    else if (delivery === "pull" && host?.execution?.mode === "request-driven")
      diagnostics.push(topology(`The handler "${handler.id}" needs a long-running consumer for "${handler.trigger.resource.id}" (provider "${provider.name}" delivers by pull), but the execution host "${host.name}" is request-driven.`, { handler: handler.id, resource: handler.trigger.resource.id, binding: provider.name, host: host.name }, "Deploy a separate long-running worker for background handlers, or select a provider that pushes events to the application."));
  }

  const execution = host?.execution;
  if (host !== undefined && execution !== undefined) {
    const { timeoutMs, concurrency } = options.limits ?? {};
    // The runtime's default invocation time limit applies when none is configured.
    const effectiveTimeoutMs = timeoutMs ?? 30_000;
    if (execution.maxTimeoutMs !== undefined && effectiveTimeoutMs > execution.maxTimeoutMs)
      diagnostics.push(bindingFailure("capability", { binding: host.name, message: `The execution host "${host.name}" limits invocations to ${execution.maxTimeoutMs} ms, but the runtime's limits.timeoutMs is ${timeoutMs ?? "30000 (the default)"}.`, hint: "Set limits.timeoutMs to at most the host's limit.", details: { requirement: "execution.timeout" } }));
    if (execution.maxConcurrency !== undefined && concurrency !== undefined && concurrency > execution.maxConcurrency)
      diagnostics.push(bindingFailure("capability", { binding: host.name, message: `The execution host "${host.name}" allows ${execution.maxConcurrency} concurrent invocations, but the runtime's limits.concurrency is ${concurrency}.`, details: { requirement: "execution.concurrency" } }));
  }

  const services = new Set(resolved.services.map(selection => selection.service));
  const idempotent = handlers.filter(handler => handler.idempotency !== undefined);
  if (idempotent.length > 0 && !services.has("idempotency"))
    diagnostics.push(bindingFailure("capability", { binding: resolved.name, message: `No provider supplies the idempotency service, which ${idempotent.map(handler => `"${handler.id}"`).join(", ")} declare${idempotent.length === 1 ? "s" : ""}.`, details: { requirement: "idempotency" } }));
  if (options.operationBudgets === true && !services.has("operation-budgets"))
    diagnostics.push(bindingFailure("capability", { binding: resolved.name, message: "No provider supplies the operation-budgets service, which events.maxEventsPerOperation needs.", details: { requirement: "operation-budgets" } }));
  return Object.freeze(diagnostics);
}

/**
 * Finds the provider that hosts execution: the default provider when it
 * implements the execution contract.
 *
 * @param resolved - The resolution.
 * @returns The execution host, if the configuration names one.
 */
function executionHost(resolved: ResolvedBindings): AnyBindingProvider | undefined {
  return resolved.providers.find(provider => provider.execution !== undefined);
}

/**
 * Builds a topology diagnostic.
 *
 * @param message - What cannot be delivered.
 * @param details - The handler, resource and providers involved.
 * @param hint - How to fix the deployment.
 * @returns An error-severity `HOLQA_BINDING_TOPOLOGY_UNSUPPORTED` diagnostic.
 */
function topology(message: string, details: NonNullable<Diagnostic["details"]>, hint: string): Diagnostic {
  return createDiagnostic({ code: diagnosticCodes.bindingTopologyUnsupported, severity: "error", message, hint, details });
}