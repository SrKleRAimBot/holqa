import type { BindingSlot } from "@/binding/runtime-binding";
import type { ConfigDescriptor } from "@/config/config-descriptor";
import type { ExtensionRequirement } from "@/extensions/extension";
import type { ResourceId } from "@/identity/resource-id";
import type { DescriptorProtocol } from "@/protocol/version";
import type { ResourceDescriptor } from "@/resources/resource-descriptor";

/**
 * Where tools look for handler modules. Patterns are globs relative to the
 * module that defines the application (conventionally `infra.ts`).
 */
export interface HandlerDiscovery {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/**
 * An application: its name, handler discovery patterns, declared resources and
 * configuration entries, plus the slot that holds its runtime binding.
 */
export interface AppDescriptor {
  readonly protocol: DescriptorProtocol;
  readonly type: "app";
  readonly name: ResourceId;
  /** A short human-readable description. */
  readonly description?: string;
  readonly handlers: HandlerDiscovery;
  /** Every declared resource, in declaration order. Identifiers are unique. */
  readonly resources: readonly ResourceDescriptor[];
  /** Every declared configuration entry, in declaration order. */
  readonly config: readonly ConfigDescriptor[];
  /** The extensions the application declares, sorted by identifier. Absent means none. */
  readonly extensions?: readonly ExtensionRequirement[];
  readonly binding: BindingSlot;
}