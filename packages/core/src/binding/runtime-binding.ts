import type { BindingLifecycle } from "@/binding/lifecycle";
import type { OperationBudgetStore } from "@/binding/operation-budgets";
import type { ResourceSources } from "@/binding/sources";
import type { ConfigDescriptor } from "@/config/config-descriptor";
import type { ExtensionBinding } from "@/extensions/extension";
import type { IdempotencyStore } from "@/idempotency/idempotency-store";
import type { TelemetryExporter } from "@/observability/telemetry";
import type {
  DrivenResourceKind,
  ResourceKind,
  ResourceKindMap
} from "@/resources/kinds";
import type {
  ResourceDescriptor,
  ResourceDescriptorOf
} from "@/resources/resource-descriptor";

/**
 * Driver factories by resource kind. A binding returns the driver that backs
 * one logical resource; it may return the same driver object for every
 * resource of a kind or a separate one per resource.
 */
export type ResourceDrivers = {
  readonly [Kind in DrivenResourceKind]?: (resource: ResourceDescriptorOf<Kind>) => ResourceKindMap[Kind]["driver"];
};

/**
 * Capabilities a binding advertises, by resource kind. A kind that is absent
 * is unsupported: binding an application that declares such a resource fails.
 */
export type BindingCapabilities = {
  readonly [Kind in ResourceKind]?: ResourceKindMap[Kind]["capabilities"];
};

/**
 * Which implementation binds one resource, and what it advertises for it. A
 * binding composed from several providers reports a different provider and
 * different capabilities per resource.
 */
export interface ResourceBindingInfo {
  /** The name of the provider (or binding) that fulfils the resource, for diagnostics. */
  readonly binding: string;
  /** What that provider advertises. Only the entry for the resource's kind is consulted. */
  readonly capabilities: BindingCapabilities;
}

/**
 * Connects the logical resources of one loaded application instance to
 * implementations: a local emulator, a test double, or drivers for external
 * infrastructure. Declarations never open connections themselves; handles look
 * up the binding when an operation runs.
 *
 * Bindings implement the data plane only. They must not require permission to
 * create or delete infrastructure.
 */
export interface RuntimeBinding {
  /** A short name used in diagnostics, for example `local` or `test`. */
  readonly name: string;
  /** What the binding advertises, by resource kind, for resources that `describe` does not cover. */
  readonly capabilities: BindingCapabilities;
  /**
   * Describes the implementation behind one resource. Absent means the
   * binding's `name` and `capabilities` apply to every resource. Composed
   * bindings use it so that capability checks compare each resource with the
   * provider actually selected for it.
   */
  readonly describe?: (resource: ResourceDescriptor) => ResourceBindingInfo;
  readonly drivers: ResourceDrivers;
  /**
   * Event sources a runtime consumes to deliver queue messages, object events
   * and scheduled runs to handlers. Absent means the binding delivers nothing;
   * its drivers can still be used, for example to send messages from an HTTP service.
   */
  readonly sources?: ResourceSources;
  /**
   * Atomic accounting of the events each root operation published, shared by
   * every process serving the application. Absent means the binding cannot
   * enforce per-operation budgets, and a runtime configured with one refuses
   * to start rather than enforce it partially.
   */
  readonly operationBudgets?: OperationBudgetStore;
  /**
   * The deduplication store handlers with an `idempotency` policy use.
   * Absent means such handlers cannot run on this binding.
   */
  readonly idempotency?: IdempotencyStore;
  /**
   * The binding's lifecycle. A runtime that installs the binding calls
   * `start` before installing it, `ready` once deliveries are registered,
   * `health` on request and `stop` after every invocation has drained.
   * Absent means the binding needs no initialization; its owner manages it.
   */
  readonly lifecycle?: BindingLifecycle;
  /**
   * Telemetry exporters the binding's telemetry service selected. A runtime
   * exports to them in addition to the exporters in its own options, under
   * the same bounded, failure-isolated pipeline.
   */
  readonly telemetry?: readonly TelemetryExporter[];
  /** The extensions the binding provides. Absent means none: required extensions make a runtime refuse to start. */
  readonly extensions?: ExtensionBinding;
  /**
   * Returns the value of a configuration entry. The binding is responsible for
   * supplying it, applying the declared default and validating it against the
   * entry's schema before the application runs.
   */
  readonly config: (entry: ConfigDescriptor) => unknown;
}

/**
 * The mutable slot through which an application instance finds its current
 * runtime binding. It is the only mutable part of an application descriptor
 * and is never serialized.
 */
export interface BindingSlot {
  current: RuntimeBinding | undefined;
}

/**
 * Creates an empty binding slot for a new application descriptor.
 *
 * @returns A slot with no binding installed.
 */
export function createBindingSlot(): BindingSlot {
  return Object.seal({ current: undefined });
}

/**
 * Returns the provider name and capabilities that apply to one resource of a
 * binding: what `describe` reports, or the binding's own name and
 * capabilities when it does not describe resources individually.
 *
 * @param binding - The installed or candidate binding.
 * @param resource - The resource whose provider is looked up.
 * @returns Who binds the resource and what it advertises.
 */
export function resourceBindingInfo(binding: RuntimeBinding, resource: ResourceDescriptor): ResourceBindingInfo {
  return binding.describe?.(resource) ?? { binding: binding.name, capabilities: binding.capabilities };
}