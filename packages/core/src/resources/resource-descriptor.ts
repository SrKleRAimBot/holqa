import type { ResourceId } from "@/identity/resource-id";
import type { DescriptorProtocol } from "@/protocol/version";
import type {
  ResourceKind,
  ResourceKindMap
} from "@/resources/kinds";

/**
 * The declarative description of one logical resource: its stable identity,
 * its kind, normalized configuration, the behaviour it requires from a binding
 * and the schemas it declares. Never contains provider-specific settings.
 *
 * @typeParam Kind - Which registered kind the descriptor describes, such as `queue`.
 */
export interface ResourceDescriptorOf<Kind extends ResourceKind> {
  readonly protocol: DescriptorProtocol;
  readonly type: "resource";
  readonly kind: Kind;
  /** The persistent logical identity, independent of any TypeScript name. */
  readonly id: ResourceId;
  readonly config: ResourceKindMap[Kind]["config"];
  readonly requirements: ResourceKindMap[Kind]["requirements"];
  readonly schemas: ResourceKindMap[Kind]["schemas"];
}

/** Any resource descriptor, discriminated by `kind`. */
export type ResourceDescriptor = { [Kind in ResourceKind]: ResourceDescriptorOf<Kind> }[ResourceKind];

/**
 * A reference from a handler (or, later, another resource) to a resource by
 * kind and identity. References never hold the resource object itself, so they
 * stay JSON data that the compiler can check against the declared graph.
 *
 * @typeParam Kind - The kind of the referenced resource.
 */
export interface ResourceReference<Kind extends ResourceKind = ResourceKind> {
  readonly kind: Kind;
  readonly id: ResourceId;
}