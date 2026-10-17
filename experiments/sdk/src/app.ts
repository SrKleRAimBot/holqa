import type {
  AppDescriptor,
  Described,
  InferOutput,
  ResourceDescriptor
} from "@holqa/experiment-model";

import type { AnyConfigEntry } from "@/config";

import {
  createBindingSlot,
  descriptorKey,
  descriptorProtocol,
  experimentCodes,
  fail,
  requireBinding
} from "@holqa/experiment-model";

import { configDescriptor } from "@/config";
import { attachOwner } from "@/internal/ownership";

/**
 * The structural minimum every resource handle satisfies. Deliberately loose:
 * a stricter constraint (for example `QueueHandle<string, StandardSchemaV1>`)
 * would reject concrete handles, because `send` is contravariant in its message type.
 */
export interface AnyResource extends Described<ResourceDescriptor> {
  readonly kind: string;
  readonly id: string;
}

/** The validated configuration values of an application, typed from its `env` declaration. */
export type ConfigValues<Env> = {
  readonly [Name in keyof Env]: Env[Name] extends { readonly schema: infer Schema extends AnyConfigEntry["schema"] } ? InferOutput<Schema> : never
};

/** The argument of {@link defineApp}. */
export interface AppDefinition<Resources extends Readonly<Record<string, AnyResource>>, Env extends Readonly<Record<string, AnyConfigEntry>>> {
  readonly name: string;
  /** Glob patterns, relative to the directory of `infra.ts`, that locate handler modules. */
  readonly handlers: readonly string[];
  /** Resource handles keyed by local alias. The alias is not the identity; each resource's `id` is. */
  readonly resources: Resources;
  readonly env?: Env;
}

/** An application definition with typed resource handles and configuration. */
export interface App<Resources, Env> extends Described<AppDescriptor> {
  readonly name: string;
  readonly resources: Resources;
  /** Configuration values. Reading one outside a runtime fails with `HOLQA_RUNTIME_NOT_BOUND`. */
  readonly env: ConfigValues<Env>;
}

/**
 * Groups resource declarations so that registries can be split across files
 * and spread into `defineApp({ resources })`. It returns its argument unchanged
 * and exists to give the group a precise type.
 *
 * @param resources - Resource handles keyed by local alias.
 * @returns The same object.
 */
export function defineResources<const Resources extends Readonly<Record<string, AnyResource>>>(resources: Resources): Resources {
  return resources;
}

/**
 * Defines an application from resource handles and configuration entries.
 *
 * Pure: performs no I/O, reads no environment variables or clocks, and creates
 * no infrastructure. Graph-level problems (duplicate identifiers, invalid
 * identifiers, missing references) are reported by the compiler, which can
 * report all of them at once, rather than thrown here.
 *
 * @param definition - Name, handler globs, resources and configuration.
 * @returns The application with typed `resources` and `env`.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when a resource already belongs to another application.
 */
export function defineApp<
  const Resources extends Readonly<Record<string, AnyResource>>,
  const Env extends Readonly<Record<string, AnyConfigEntry>> = {}
>(definition: AppDefinition<Resources, Env>): App<Resources, Env> {
  const env = definition.env ?? ({} as Env);
  const descriptor: AppDescriptor = Object.freeze({
    protocol: descriptorProtocol,
    type: "app",
    name: definition.name,
    handlers: Object.freeze([...definition.handlers]),
    resources: Object.freeze(Object.values(definition.resources).map(resource => resource[descriptorKey])),
    config: Object.freeze(Object.entries(env).map(([name, entry]) => configDescriptor(name, entry))),
    binding: createBindingSlot()
  });

  for (const [alias, resource] of Object.entries(definition.resources)) {
    if (resource[descriptorKey]?.type !== "resource")
      fail(experimentCodes.declarationInvalid, `resources.${alias} is not a Holqa resource.`);
    attachOwner(resource, descriptor);
  }

  const values = {};
  for (const name of Object.keys(env)) {
    Object.defineProperty(values, name, {
      enumerable: true,
      get: () => requireBinding(descriptor, `env.${name}`).config(name)
    });
  }

  return Object.freeze({
    [descriptorKey]: descriptor,
    name: definition.name,
    resources: definition.resources,
    env: Object.freeze(values) as ConfigValues<Env>
  });
}