import type { AppDescriptor } from "@/app/app-descriptor";
import type { ConfigDescriptor } from "@/config/config-descriptor";
import type { HandlerDescriptor } from "@/handlers/handler-descriptor";
import type { ResourceDescriptor } from "@/resources/resource-descriptor";

import {
  isTriggerKind,
  resourceKindOfTrigger
} from "@/handlers/triggers";
import { isResourceId } from "@/identity/resource-id";
import {
  descriptorKey,
  descriptorProtocol
} from "@/protocol/version";
import { isResourceKind } from "@/resources/kinds";
import { isStandardSchema } from "@/schema/standard-schema";

/** Any Holqa descriptor, discriminated by `type`. */
export type Descriptor = AppDescriptor | ResourceDescriptor | HandlerDescriptor | ConfigDescriptor;

/**
 * A value that carries a Holqa descriptor under the `~holqa` key.
 *
 * @typeParam D - The descriptor type. Unconstrained so that generic descriptors
 * such as `ResourceDescriptorOf<Kind>` can be carried before `Kind` is known.
 */
export interface Described<D = Descriptor> {
  readonly [descriptorKey]: D;
}

/** Structural checks for each descriptor type, applied before a descriptor is trusted. */
const shapeChecks: { readonly [Type in Descriptor["type"]]: (descriptor: object) => boolean } = {
  app: descriptor => hasIdentifier(descriptor, "name")
    && "handlers" in descriptor && isObject(descriptor.handlers) && "include" in descriptor.handlers && Array.isArray(descriptor.handlers.include)
    && "resources" in descriptor && Array.isArray(descriptor.resources)
    && (descriptor.resources as readonly unknown[]).every(entry => isObject(entry) && "type" in entry && entry.type === "resource" && shapeChecks.resource(entry))
    && "config" in descriptor && Array.isArray(descriptor.config)
    && (descriptor.config as readonly unknown[]).every(entry => isObject(entry) && "type" in entry && entry.type === "config" && shapeChecks.config(entry))
    && "binding" in descriptor && isObject(descriptor.binding),
  resource: descriptor => "kind" in descriptor && isResourceKind(descriptor.kind)
    && hasIdentifier(descriptor, "id")
    && "config" in descriptor && isObject(descriptor.config)
    && "requirements" in descriptor && isObject(descriptor.requirements)
    && "schemas" in descriptor && isObject(descriptor.schemas) && Object.values(descriptor.schemas).every(isStandardSchema),
  handler: descriptor => "definition" in descriptor && isObject(descriptor.definition)
    && hasIdentifier(descriptor.definition, "id")
    && "trigger" in descriptor.definition && isObject(descriptor.definition.trigger)
    && "kind" in descriptor.definition.trigger && isTriggerKind(descriptor.definition.trigger.kind)
    && "resource" in descriptor.definition.trigger && isObject(descriptor.definition.trigger.resource)
    && "kind" in descriptor.definition.trigger.resource && descriptor.definition.trigger.resource.kind === resourceKindOfTrigger(descriptor.definition.trigger.kind)
    && hasIdentifier(descriptor.definition.trigger.resource, "id")
    && "schemas" in descriptor && isObject(descriptor.schemas)
    && "invoke" in descriptor && typeof descriptor.invoke === "function",
  config: descriptor => hasString(descriptor, "name")
    && "sensitive" in descriptor && typeof descriptor.sensitive === "boolean"
    && "schema" in descriptor && isStandardSchema(descriptor.schema)
};

/**
 * Reads the descriptor of a value without trusting its type. Values from a
 * second copy of `@holqa/core` are recognized, because the check is structural.
 *
 * The check covers the protocol version, the descriptor type, identifiers
 * (parsed with the identifier grammar), registered resource and trigger kinds,
 * the kind of a handler's resource reference, schemas, and the elements of an
 * application's resource and configuration lists. The contents of each kind's
 * `config` and `requirements` are trusted as written by the SDK that created
 * them; a reader that must not trust its producer validates those separately.
 *
 * @param value - Any value, for example a module export.
 * @returns The descriptor, or `undefined` when the value carries none, uses a
 * different protocol version, or names a resource or trigger kind this version
 * does not define.
 */
export function getDescriptor(value: unknown): Descriptor | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || !(descriptorKey in value))
    return undefined;
  const descriptor: unknown = value[descriptorKey];
  if (!isObject(descriptor) || !("protocol" in descriptor) || descriptor.protocol !== descriptorProtocol || !("type" in descriptor))
    return undefined;
  const { type } = descriptor;
  if (typeof type !== "string" || !Object.hasOwn(shapeChecks, type))
    return undefined;
  return shapeChecks[type as Descriptor["type"]](descriptor) ? descriptor as Descriptor : undefined;
}

/**
 * Reads an application descriptor, such as the default export of `infra.ts`.
 *
 * @param value - Any value.
 * @returns The application descriptor, or `undefined` when the value is not a Holqa application.
 */
export function getAppDescriptor(value: unknown): AppDescriptor | undefined {
  const descriptor = getDescriptor(value);
  return descriptor?.type === "app" ? descriptor : undefined;
}

/**
 * Reads a resource descriptor, such as a resource handle's.
 *
 * @param value - Any value.
 * @returns The resource descriptor, or `undefined` when the value is not a Holqa resource.
 */
export function getResourceDescriptor(value: unknown): ResourceDescriptor | undefined {
  const descriptor = getDescriptor(value);
  return descriptor?.type === "resource" ? descriptor : undefined;
}

/**
 * Reads a handler descriptor, such as a handler module's export.
 *
 * @param value - Any value.
 * @returns The handler descriptor, or `undefined` when the value is not a Holqa handler.
 */
export function getHandlerDescriptor(value: unknown): HandlerDescriptor | undefined {
  const descriptor = getDescriptor(value);
  return descriptor?.type === "handler" ? descriptor : undefined;
}

/**
 * Reads a configuration entry descriptor.
 *
 * @param value - Any value.
 * @returns The configuration descriptor, or `undefined` when the value is not a Holqa configuration entry.
 */
export function getConfigDescriptor(value: unknown): ConfigDescriptor | undefined {
  const descriptor = getDescriptor(value);
  return descriptor?.type === "config" ? descriptor : undefined;
}

/**
 * Reports whether a value is a non-null object.
 *
 * @param value - The value to inspect.
 * @returns `true` for objects (including arrays) other than `null`.
 */
function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Reports whether an object has a property that satisfies the identifier grammar.
 *
 * @param value - The object to inspect.
 * @param key - The property name.
 * @returns `true` when `value[key]` is a valid `ResourceId`.
 */
function hasIdentifier(value: object, key: string): boolean {
  return key in value && isResourceId((value as Record<string, unknown>)[key]);
}

/**
 * Reports whether an object has a string property.
 *
 * @param value - The object to inspect.
 * @param key - The property name.
 * @returns `true` when `value[key]` is a string.
 */
function hasString(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === "string";
}