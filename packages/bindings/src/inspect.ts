import type {
  AnyBindingProvider,
  BindingServiceName,
  CapabilityEmulation,
  Diagnostic,
  ExecutionCapabilities,
  ExtensionReference,
  JsonObject,
  ProviderRole,
  ProviderTopology,
  ResourceKind,
  ResourceKindMap
} from "@holqa/core";

import type {
  ResolvedBindings,
  ResourceSelectionSource,
  ServiceSelectionSource
} from "@/resolve";
import type {
  BindingValidationOptions,
  ValidatedHandler
} from "@/validate";

import {
  providedCapabilities,
  requiredCapabilities
} from "@holqa/core";

import { validateBindings } from "@/validate";

/** The format tag of a binding report. */
export const bindingReportFormat = "holqa.bindings/1";

/**
 * How a provider meets one required capability: natively, through an
 * explicitly enabled emulation, or not at all.
 */
export type CapabilitySupport = "native" | "emulated" | "unsupported";

/** One required capability of a resource and how its provider meets it. */
export interface RequirementReport {
  readonly capability: string;
  readonly support: CapabilitySupport;
}

/** The binding of one resource. */
export interface ResourceReport {
  readonly id: string;
  readonly kind: ResourceKind;
  /** The selected provider's name. */
  readonly provider: string;
  /** Why it was selected: its own entry, its kind's entry, or the default. */
  readonly selection: ResourceSelectionSource;
  /** Every required capability, including `trigger.<kind>` for handlers when they were given. */
  readonly requirements: readonly RequirementReport[];
}

/** The providers of one service. */
export interface ServiceReport {
  readonly service: BindingServiceName;
  readonly providers: readonly string[];
  readonly selection: ServiceSelectionSource;
}

/** The implementation selected for one extension. */
export interface ExtensionReport {
  readonly id: string;
  /** The version the provider implements. */
  readonly version: number;
  readonly provider: string;
  readonly selection: "extension" | "default";
  /** Whether the application requires it; `false` for optional extensions and dependencies. */
  readonly required: boolean;
}

/** One selected provider, as data. */
export interface ProviderReport {
  readonly name: string;
  /** The implementation's identifier. */
  readonly provider: string;
  readonly role: ProviderRole;
  readonly contracts: Readonly<Record<string, number>>;
  /** The provided capabilities in the required-capability vocabulary, by resource kind. */
  readonly capabilities: Readonly<Record<string, readonly string[]>>;
  /** The advertised capabilities as declared, including quantities, by resource kind. */
  readonly limits: Readonly<Record<string, JsonObject>>;
  readonly services: readonly BindingServiceName[];
  readonly emulations: readonly CapabilityEmulation[];
  /** The extensions the provider implements. */
  readonly extensions: readonly ExtensionReference[];
  readonly topology: ProviderTopology;
  readonly execution?: ExecutionCapabilities;
  /** Non-secret settings. */
  readonly settings: JsonObject;
  /** The names of the credentials the provider resolves; never values. */
  readonly credentials: readonly string[];
}

/**
 * A binding configuration resolved and validated, as JSON data: which
 * provider binds each resource and why, how each requirement is met, the
 * services, every provider's declaration and every problem. Contains no
 * credential values.
 */
export interface BindingReport {
  readonly format: typeof bindingReportFormat;
  /** The configuration's name. */
  readonly name: string;
  readonly application: string;
  /** Sorted by resource identifier. */
  readonly resources: readonly ResourceReport[];
  readonly services: readonly ServiceReport[];
  /** The selected extension implementations, sorted by identifier. */
  readonly extensions: readonly ExtensionReport[];
  /** In opening order. */
  readonly providers: readonly ProviderReport[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Describes a resolved binding configuration for people and tools:
 * `holqa bindings inspect` prints it, and binding manifests are built from
 * it. It validates the configuration (`validateBindings`) and marks every
 * requirement the selected provider does not meet as `unsupported`, and
 * every requirement it meets through an emulation as `emulated`.
 *
 * @param resolved - A resolution from `resolveBindings`.
 * @param options - The handlers, limits and settings, as for `validateBindings`.
 * @returns The report, plain JSON data.
 */
export function inspectBindings(resolved: ResolvedBindings, options: BindingValidationOptions = {}): BindingReport {
  const handlers: readonly ValidatedHandler[] = [...options.handlers ?? []];
  const diagnostics = validateBindings(resolved, { ...options, ...options.handlers === undefined ? {} : { handlers } });
  const unmet = new Map<string, Set<string>>();
  const handlerResources = new Map(handlers.map(handler => [handler.id as string, handler.trigger.resource.id as string]));
  for (const diagnostic of diagnostics) {
    const details: { readonly requirement?: unknown; readonly resource?: unknown; readonly handler?: unknown } = diagnostic.details ?? {};
    const requirement = typeof details.requirement === "string" ? details.requirement : undefined;
    const resource = typeof details.resource === "string" ? details.resource : typeof details.handler === "string" ? handlerResources.get(details.handler) : undefined;
    if (requirement !== undefined && resource !== undefined)
      unmet.set(resource, (unmet.get(resource) ?? new Set()).add(requirement));
  }
  const resources = resolved.resources.map(({ resource, provider, source }): ResourceReport => {
    const triggers = [...new Set(handlers.filter(handler => handler.trigger.resource.id === resource.id).map(handler => `trigger.${handler.trigger.kind}`))].sort();
    const emulated = new Set((provider.emulations ?? []).filter(emulation => emulation.kind === resource.kind).map(emulation => emulation.capability));
    const missing = unmet.get(resource.id) ?? new Set();
    return {
      id: resource.id,
      kind: resource.kind,
      provider: provider.name,
      selection: source,
      requirements: [...requiredCapabilities(resource), ...triggers].map(capability => ({
        capability,
        support: missing.has(capability) ? "unsupported" : emulated.has(capability) ? "emulated" : "native"
      }))
    };
  });
  return {
    format: bindingReportFormat,
    name: resolved.name,
    application: resolved.app.name,
    resources,
    services: resolved.services.map(selection => ({ service: selection.service, providers: selection.providers.map(provider => provider.name), selection: selection.source })),
    extensions: resolved.extensions.map(selection => ({ id: selection.id, version: selection.version, provider: selection.provider.name, selection: selection.source, required: (resolved.app.extensions ?? []).some(requirement => requirement.id === selection.id && requirement.required) })),
    providers: resolved.providers.map(describeProvider),
    diagnostics
  };
}

/**
 * Describes one provider's declaration as data.
 *
 * @param provider - A validated provider.
 * @returns Its report entry.
 */
function describeProvider(provider: AnyBindingProvider): ProviderReport {
  const kinds = (Object.keys(provider.resources) as ResourceKind[]).sort();
  return {
    name: provider.name,
    provider: provider.provider,
    role: provider.role,
    contracts: Object.fromEntries(Object.entries(provider.contracts).sort(([left], [right]) => left < right ? -1 : 1)) as Record<string, number>,
    capabilities: Object.fromEntries(kinds.map(kind => [kind, providedCapabilities(kind, provider.resources[kind] as ResourceKindMap[typeof kind]["capabilities"])])),
    limits: Object.fromEntries(kinds.map(kind => [kind, provider.resources[kind] as unknown as JsonObject])),
    services: (Object.keys(provider.services) as BindingServiceName[]).sort(),
    emulations: provider.emulations ?? [],
    extensions: (provider.extensions ?? []).map(declaration => ({ id: declaration.id, version: declaration.version })),
    topology: provider.topology ?? { delivery: "none", state: "shared" },
    ...provider.execution === undefined ? {} : { execution: provider.execution },
    settings: provider.settings ?? {},
    credentials: (provider.credentials ?? []).map(reference => reference.name).sort()
  };
}