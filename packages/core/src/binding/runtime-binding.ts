import type { ResourceSources } from "@/binding/sources";
import type { ConfigDescriptor } from "@/config/config-descriptor";
import type {
  DrivenResourceKind,
  ResourceKind,
  ResourceKindMap
} from "@/resources/kinds";
import type { ResourceDescriptorOf } from "@/resources/resource-descriptor";

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
  readonly capabilities: BindingCapabilities;
  readonly drivers: ResourceDrivers;
  /**
   * Event sources a runtime consumes to deliver queue messages, object events
   * and scheduled runs to handlers. Absent means the binding delivers nothing;
   * its drivers can still be used, for example to send messages from an HTTP service.
   */
  readonly sources?: ResourceSources;
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