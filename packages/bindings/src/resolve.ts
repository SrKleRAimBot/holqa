import type {
  AnyBindingProvider,
  AppDescriptor,
  BindingServiceName,
  Diagnostic,
  ResourceDescriptor
} from "@holqa/core";

import type { BindingsDefinition } from "@/define-bindings";

import {
  createDiagnostic,
  diagnosticCodes,
  HolqaError,
  isResourceKind,
  validateProvider
} from "@holqa/core";

import { environmentConfig } from "@/environment-config";

/** Why a provider was selected for a resource: its own entry, its kind's entry, or the default. */
export type ResourceSelectionSource = "resource" | "kind" | "default";

/** The provider selected for one resource. */
export interface ResourceSelection {
  readonly resource: ResourceDescriptor;
  readonly provider: AnyBindingProvider;
  readonly source: ResourceSelectionSource;
}

/** Why providers were selected for a service: an entry in `services`, the default provider, or Holqa's built-in fallback. */
export type ServiceSelectionSource = "service" | "default" | "builtin";

/** The providers selected for one service. */
export interface ServiceSelectionResult {
  readonly service: BindingServiceName;
  /** In order: the first `config` source with a value wins; every `telemetry` provider receives every export. */
  readonly providers: readonly AnyBindingProvider[];
  readonly source: ServiceSelectionSource;
}

/**
 * A binding configuration resolved against its application: one provider per
 * resource and the providers of every service, deterministic for equal
 * input. Problems are reported, not thrown, so tools can show all of them.
 */
export interface ResolvedBindings {
  readonly name: string;
  readonly app: AppDescriptor;
  /** One selection per resource that has a provider, sorted by resource identifier. */
  readonly resources: readonly ResourceSelection[];
  /** The selected services, in the order config, telemetry, idempotency, operation-budgets. */
  readonly services: readonly ServiceSelectionResult[];
  /** Every distinct selected provider, in the order they are opened: configuration first, then other services, then resource providers. */
  readonly providers: readonly AnyBindingProvider[];
  /** Every problem found. The configuration is usable when none has `error` severity. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The built-in configuration provider used when no other supplies configuration. One shared instance keeps resolution deterministic. */
const builtinConfig = environmentConfig();

/** Every service, in resolution order. */
const serviceOrder: readonly BindingServiceName[] = ["config", "telemetry", "idempotency", "operation-budgets"];

/**
 * Resolves a binding configuration against its application. Each resource
 * gets exactly one provider by a fixed precedence (its entry in `resources`,
 * then its kind's entry in `kinds`, then `defaults`); a selected provider that
 * does not bind the resource's kind is an error, never a reason to fall
 * through to the next level. Each service gets the providers listed in
 * `services`, else the default provider when it supplies the service; for
 * `config`, Holqa's environment variable provider is the built-in fallback.
 *
 * Every provider is validated (`validateProvider`), and two different
 * providers may not share a name, because names identify providers in
 * diagnostics and manifests. Nothing is opened.
 *
 * @param definition - A binding configuration from `defineBindings`.
 * @returns The selections and every problem found: `HOLQA_BINDING_RESOURCE_UNKNOWN`, `HOLQA_BINDING_KIND_MISMATCH`,
 * `HOLQA_BINDING_MISSING`, `HOLQA_BINDING_CONFIG_INVALID` and `HOLQA_BINDING_CONTRACT_INCOMPATIBLE`.
 */
export function resolveBindings(definition: BindingsDefinition): ResolvedBindings {
  const { app } = definition;
  const diagnostics: Diagnostic[] = [];
  const valid = new Map<AnyBindingProvider, boolean>();
  /**
   * Validates a provider once and records its problems.
   *
   * @param provider - The candidate.
   * @param where - Where it was selected, for messages.
   * @returns `true` when it is a valid provider.
   */
  const check = (provider: unknown, where: string): provider is AnyBindingProvider => {
    if (typeof provider === "object" && provider !== null && valid.has(provider as AnyBindingProvider))
      return valid.get(provider as AnyBindingProvider)!;
    const problems = validateProvider(provider);
    diagnostics.push(...problems.map(problem => ({ ...problem, message: `${where}: ${problem.message}` })));
    if (typeof provider === "object" && provider !== null)
      valid.set(provider as AnyBindingProvider, problems.length === 0);
    return problems.length === 0;
  };
  const declared = new Map(app.resources.map(resource => [resource.id as string, resource]));
  const declaredKinds = new Set<string>(app.resources.map(resource => resource.kind));

  for (const id of Object.keys(definition.resources).sort()) {
    if (!declared.has(id))
      diagnostics.push(problem(diagnosticCodes.bindingResourceUnknown, `"resources" selects a provider for "${id}", which the application "${app.name}" does not declare.`, { resource: id }, "Remove the entry, or use the resource's identifier (not its alias)."));
  }
  for (const kind of Object.keys(definition.kinds).sort()) {
    if (!isResourceKind(kind))
      diagnostics.push(problem(diagnosticCodes.bindingConfigInvalid, `"kinds" selects a provider for "${kind}", which is not a resource kind.`, { kind }));
    else if (!declaredKinds.has(kind))
      diagnostics.push(problem(diagnosticCodes.bindingResourceUnknown, `"kinds" selects a provider for ${kind} resources, but the application "${app.name}" declares none.`, { kind }, "Remove the entry."));
  }

  const resources: ResourceSelection[] = [];
  for (const resource of [...app.resources].sort((left, right) => compare(left.id, right.id))) {
    const own = definition.resources[resource.id];
    const ofKind = definition.kinds[resource.kind];
    const [provider, source] = own !== undefined
      ? [own, "resource" as const]
      : ofKind !== undefined ? [ofKind, "kind" as const] : [definition.defaults, "default" as const];
    if (provider === undefined) {
      diagnostics.push(problem(diagnosticCodes.bindingMissing, `No provider is selected for the ${resource.kind} "${resource.id}".`, { resource: resource.id, kind: resource.kind }, "Select one in \"resources\" or \"kinds\", or set \"defaults\" to a platform provider."));
      continue;
    }
    const where = source === "resource" ? `resources["${resource.id}"]` : source === "kind" ? `kinds["${resource.kind}"]` : "defaults";
    if (!check(provider, where))
      continue;
    if (!Object.hasOwn(provider.resources, resource.kind)) {
      diagnostics.push(problem(diagnosticCodes.bindingKindMismatch, `${where} selects the provider "${provider.name}" for the ${resource.kind} "${resource.id}", but it does not bind ${resource.kind} resources.`, { resource: resource.id, kind: resource.kind, binding: provider.name, selection: source }, "Select a provider that binds this kind; Holqa never falls through to another provider."));
      continue;
    }
    resources.push(Object.freeze({ resource, provider, source }));
  }

  const services: ServiceSelectionResult[] = [];
  for (const service of serviceOrder) {
    const selected = definition.services[service];
    if (selected !== undefined) {
      const list = (Array.isArray(selected) ? selected : [selected]) as readonly unknown[];
      const providers: AnyBindingProvider[] = [];
      for (const [index, provider] of list.entries()) {
        const where = Array.isArray(selected) ? `services["${service}"][${index}]` : `services["${service}"]`;
        if (!check(provider, where))
          continue;
        if (provider.services[service] !== true) {
          diagnostics.push(problem(diagnosticCodes.bindingKindMismatch, `${where} selects the provider "${provider.name}", which does not supply the ${service} service.`, { service, binding: provider.name, selection: "service" }));
          continue;
        }
        providers.push(provider);
      }
      if (list.length === 0)
        diagnostics.push(problem(diagnosticCodes.bindingConfigInvalid, `services["${service}"] is an empty list; omit it to use the default.`, { service }));
      if (providers.length > 0)
        services.push(Object.freeze({ service, providers: Object.freeze(providers), source: "service" }));
      continue;
    }
    const fallback = definition.defaults;
    if (fallback !== undefined && check(fallback, "defaults") && fallback.services[service] === true)
      services.push(Object.freeze({ service, providers: Object.freeze([fallback]), source: "default" }));
    else if (service === "config")
      services.push(Object.freeze({ service, providers: Object.freeze([builtinConfig]), source: "builtin" }));
  }

  const providers: AnyBindingProvider[] = [];
  for (const provider of [...services.flatMap(selection => selection.providers), ...resources.map(selection => selection.provider)]) {
    if (!providers.includes(provider))
      providers.push(provider);
  }
  const names = new Map<string, AnyBindingProvider>();
  for (const provider of providers) {
    const other = names.get(provider.name);
    if (other !== undefined && other !== provider)
      diagnostics.push(problem(diagnosticCodes.bindingConfigInvalid, `Two different providers are named "${provider.name}".`, { binding: provider.name }, "Give each configured provider a distinct name; names identify providers in diagnostics and manifests."));
    names.set(provider.name, provider);
  }
  return Object.freeze({
    name: definition.name,
    app,
    resources: Object.freeze(resources),
    services: Object.freeze(services),
    providers: Object.freeze(providers),
    diagnostics: Object.freeze(diagnostics)
  });
}

/**
 * Throws when a resolution reported errors.
 *
 * @param resolved - A resolution.
 * @returns The same resolution, for chaining.
 * @throws {HolqaError} With every error-severity diagnostic of the resolution.
 */
export function assertResolved(resolved: ResolvedBindings): ResolvedBindings {
  const errors = resolved.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (errors.length > 0)
    throw new HolqaError(errors);
  return resolved;
}

/**
 * Builds an error diagnostic.
 *
 * @param code - The diagnostic code.
 * @param message - What is wrong.
 * @param details - Structured details.
 * @param hint - How to fix it.
 * @returns The diagnostic.
 */
function problem(code: Diagnostic["code"], message: string, details: NonNullable<Diagnostic["details"]>, hint?: string): Diagnostic {
  return createDiagnostic({ code, severity: "error", message, details, ...hint === undefined ? {} : { hint } });
}

/**
 * Compares two strings by code unit, for a locale-independent order.
 *
 * @param left - The first string.
 * @param right - The second string.
 * @returns A negative number, zero or a positive number.
 */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}