import type {
  Described,
  HandlerDescriptorOf,
  ResourceDescriptor,
  ResourceDescriptorOf,
  ResourceKind,
  TriggerKind
} from "@holqa/core";

/**
 * The part every resource handle shares: its kind, its persistent identifier
 * and its descriptor. The object key a handle is stored under in
 * `defineApp({ resources })` is only a local alias for ergonomic access.
 *
 * @typeParam Kind - Which kind of resource the handle declares, such as `queue`.
 * @typeParam Id - The literal identifier.
 */
export interface ResourceHandle<Kind extends ResourceKind, Id extends string> extends Described<ResourceDescriptorOf<Kind>> {
  readonly kind: Kind;
  readonly id: Id;
}

/**
 * The structural minimum every resource handle satisfies, used as a
 * constraint. Deliberately loose: a stricter constraint such as
 * `QueueHandle<string, StandardSchemaV1>` would reject concrete handles,
 * because operations like `send` are contravariant in their message type.
 */
export interface AnyResource extends Described<ResourceDescriptor> {
  readonly kind: ResourceKind;
  readonly id: string;
}

/** A record of resource handles keyed by local alias. */
export type ResourceRecord = Readonly<Record<string, AnyResource>>;

/**
 * A registered handler: its descriptor plus typed identifiers for inspection.
 *
 * @typeParam Trigger - The trigger kind.
 * @typeParam HandlerId - The handler's literal identifier.
 * @typeParam TargetId - The identifier of the resource the handler belongs to.
 */
export interface HandlerRegistration<Trigger extends TriggerKind, HandlerId extends string, TargetId extends string> extends Described<HandlerDescriptorOf<Trigger>> {
  readonly trigger: Trigger;
  readonly id: HandlerId;
  readonly resourceId: TargetId;
}

/** The identifier of a resource handle. */
export type ResourceIdOf<Handle extends AnyResource> = Handle["id"];

/** The union of identifiers declared by a record of resource handles. */
export type ResourceIds<Resources extends ResourceRecord> = Resources[keyof Resources]["id"];

/**
 * Looks up a handle by its persistent identifier rather than its alias.
 *
 * @typeParam Resources - A record of resource handles.
 * @typeParam Id - The identifier to find.
 */
export type ResourceById<Resources extends ResourceRecord, Id extends ResourceIds<Resources>> = {
  [Alias in keyof Resources]: Resources[Alias] extends { readonly id: Id } ? Resources[Alias] : never
}[keyof Resources];

/**
 * The aliases of a record whose resources have a given kind.
 *
 * @typeParam Resources - A record of resource handles.
 * @typeParam Kind - The kind to select, such as `queue`.
 */
export type ResourceAliasesOfKind<Resources extends ResourceRecord, Kind extends ResourceKind> = {
  [Alias in keyof Resources]: Resources[Alias]["kind"] extends Kind ? Alias : never
}[keyof Resources];