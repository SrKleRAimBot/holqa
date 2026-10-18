import type {
  AppDescriptor,
  ConfigDescriptor,
  Described,
  HandlerDiscovery,
  InferOutput,
  ResourceDescriptor
} from "@holqa/core";

import type {
  AnyConfigEntry,
  EnvRecord
} from "@/config/config-entry";
import type {
  AnyHttpMiddleware,
  CheckMiddlewareChain,
  ExtendContext,
  MiddlewareChainContext
} from "@/http/middleware";
import type { ResourceRecord } from "@/resources/handle";
import type { HttpApiHandle } from "@/resources/http";
import type {
  CheckResourceId,
  CheckUniqueResourceIds
} from "@/types/checks";

import {
  checkIdentities,
  createBindingSlot,
  descriptorKey,
  descriptorProtocol,
  getResourceDescriptor,
  isStandardSchema,
  readConfig
} from "@holqa/core";

import { middlewareList } from "@/http/middleware";
import { setAppMiddleware } from "@/internal/app-middleware";
import {
  DeclarationProblems,
  freezeJson,
  requireOptions
} from "@/internal/declaration";
import {
  claim,
  currentOwner
} from "@/internal/ownership";

/** Configuration entry names that map safely onto environment variable names. */
const envNamePattern = /^[A-Z_]\w*$/i;

/**
 * Where tools look for handler modules: glob patterns relative to the module
 * that defines the application, either as a list or with exclusions.
 */
export type HandlerDiscoveryOptions = readonly string[] | {
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
};

/**
 * The argument of {@link defineApp}.
 *
 * @typeParam Resources - Resource handles keyed by local alias.
 * @typeParam Env - Configuration entries keyed by name.
 */
export interface AppDefinition<Resources extends ResourceRecord, Env extends EnvRecord, Name extends string = string, Middleware extends readonly AnyHttpMiddleware[] = []> {
  /** The application's name, in resource identifier grammar (for example `commerce`). */
  readonly name: Name;
  /** A short human-readable description. */
  readonly description?: string;
  /** Glob patterns that locate handler modules. Discovery itself is done by tools, not by `defineApp`. */
  readonly handlers?: HandlerDiscoveryOptions;
  /** Resource handles keyed by local alias. The alias is not the identity; each resource's `id` is. */
  readonly resources: Resources;
  /** Secrets and variables keyed by name. */
  readonly env?: Env;
  /**
   * HTTP middleware for every route and procedure of every API in the
   * application. It runs before API and route middleware, and the context it
   * adds is visible to routes registered through `app.resources`.
   */
  readonly middleware?: Middleware & CheckMiddlewareChain<{}, Middleware>;
}

/**
 * The configuration values of an application, typed from its `env`
 * declaration with each schema's output type.
 *
 * @typeParam Env - Configuration entries keyed by name.
 */
export type ConfigValues<Env> = {
  readonly [Name in keyof Env]: Env[Name] extends { readonly schema: infer Schema extends AnyConfigEntry["schema"] } ? InferOutput<Schema> : never
};

/**
 * An application definition with typed resource handles and configuration.
 *
 * @typeParam Resources - Resource handles keyed by local alias, exactly as declared.
 * @typeParam Env - Configuration entries keyed by name.
 */
export interface App<Resources extends ResourceRecord, Env extends EnvRecord, Context extends object = {}> extends Described<AppDescriptor> {
  readonly name: string;
  /**
   * The handles passed to `defineApp`, unchanged at run time, so their types
   * flow to importing modules. HTTP API handles additionally carry the
   * context of the application's middleware.
   */
  readonly resources: AppResources<Resources, Context>;
  /** Configuration values. Each read goes to the runtime binding; reading one outside a runtime fails with `HOLQA_RUNTIME_NOT_BOUND`. */
  readonly env: ConfigValues<Env>;
}

/**
 * The resource handles of an application as importing modules see them: HTTP
 * API handles carry the application middleware's context in front of their
 * own; every other handle is unchanged. Without application middleware the
 * record is exactly the declared one.
 *
 * @typeParam Resources - Resource handles keyed by local alias.
 * @typeParam Context - The context the application's middleware provides.
 */
export type AppResources<Resources extends ResourceRecord, Context extends object> = [keyof Context] extends [never]
  ? Resources
  : { readonly [Alias in keyof Resources]: Resources[Alias] extends HttpApiHandle<infer Id, infer ApiContext> ? HttpApiHandle<Id, ExtendContext<Context, ApiContext>> : Resources[Alias] };

/**
 * Defines an application from resource handles and configuration entries.
 *
 * Pure: performs no I/O, reads no environment variables, clock or randomness,
 * opens no connection and creates no infrastructure. It validates the whole
 * declaration and reports every problem at once. Duplicate literal identifiers
 * are also rejected at compile time.
 *
 * @param definition - Name, handler discovery patterns, resources and configuration.
 * @returns The application, exposing the same resource handles and typed configuration values.
 * @throws {HolqaError} With every problem found: `HOLQA_RESOURCE_ID_INVALID` for an invalid name,
 * `HOLQA_RESOURCE_ID_DUPLICATE` for identifiers declared more than once, and `HOLQA_DECLARATION_INVALID`
 * for malformed fields, non-resource values or resources that already belong to another application.
 */
export function defineApp<
  const Resources extends ResourceRecord,
  const Env extends EnvRecord = {},
  const Name extends string = string,
  const Middleware extends readonly AnyHttpMiddleware[] = []
>(definition: AppDefinition<Resources, Env, Name, Middleware> & CheckUniqueResourceIds<Resources> & CheckResourceId<Name>): App<Resources, Env, MiddlewareChainContext<{}, Middleware>> {
  const raw = requireOptions(definition, "defineApp");
  const problems = new DeclarationProblems(`application "${String(raw.name)}"`);
  const nameCandidate = problems.identifier(raw.name, "name");
  if (raw.description !== undefined && typeof raw.description !== "string")
    problems.invalid("\"description\" must be a string.");
  const handlers = handlerDiscovery(raw.handlers, problems);
  const resources = resourceEntries(raw.resources, problems);
  const config = configEntries(raw.env, problems);
  const middleware = middlewareList(raw.middleware, problems);
  const name = problems.valid(nameCandidate);

  const descriptor: AppDescriptor = Object.freeze({
    protocol: descriptorProtocol,
    type: "app",
    name,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    handlers,
    resources: Object.freeze(resources.map(([, resource]) => resource)),
    config: Object.freeze(config),
    binding: createBindingSlot()
  });
  for (const [handle] of resources)
    claim(handle, descriptor);
  setAppMiddleware(descriptor, middleware);

  const env = {};
  for (const entry of config)
    Object.defineProperty(env, entry.name, { enumerable: true, get: () => readConfig(descriptor, entry) });

  return Object.freeze({
    [descriptorKey]: descriptor,
    name: definition.name,
    // Only the types change: every route and procedure of these APIs runs the
    // application middleware recorded by `setAppMiddleware` above.
    resources: definition.resources as AppResources<Resources, MiddlewareChainContext<{}, Middleware>>,
    env: Object.freeze(env) as ConfigValues<Env>
  });
}

/**
 * Normalizes and checks handler discovery patterns. Patterns must stay inside
 * the application: absolute paths and `..` segments are rejected.
 *
 * @param value - The `handlers` option, unvalidated.
 * @param problems - Where to record problems.
 * @returns Frozen include and exclude lists.
 */
function handlerDiscovery(value: unknown, problems: DeclarationProblems): HandlerDiscovery {
  const isList = Array.isArray(value);
  const options = (isList ? { include: value } : value ?? { include: [] }) as { readonly include?: unknown; readonly exclude?: unknown };
  if (typeof options !== "object" || options === null) {
    problems.invalid("\"handlers\" must be a list of glob patterns or { include, exclude }.");
    return freezeJson({ include: [], exclude: [] });
  }
  return freezeJson({
    include: patternList(options.include, isList ? "handlers" : "handlers.include", problems),
    exclude: patternList(options.exclude ?? [], "handlers.exclude", problems)
  });
}

/**
 * Checks one list of glob patterns.
 *
 * @param value - The list, unvalidated.
 * @param option - The option name, for messages.
 * @param problems - Where to record problems.
 * @returns A copy of the valid patterns.
 */
function patternList(value: unknown, option: string, problems: DeclarationProblems): string[] {
  if (!Array.isArray(value)) {
    problems.invalid(`"${option}" must be a list of glob patterns.`);
    return [];
  }
  const patterns: string[] = [];
  for (const pattern of value as readonly unknown[]) {
    if (typeof pattern !== "string" || pattern.trim() === "")
      problems.invalid(`"${option}" must contain non-empty strings.`);
    else if (/^(?:[/\\]|[A-Z]:)/i.test(pattern) || pattern.split(/[/\\]/).includes(".."))
      problems.invalid(`"${option}" pattern "${pattern}" must be relative to the application and must not contain "..".`);
    else
      patterns.push(pattern);
  }
  return patterns;
}

/**
 * Checks the `resources` record: every value must be a resource handle, owned
 * by no other application, and every identifier must be unique.
 *
 * @param value - The `resources` option, unvalidated.
 * @param problems - Where to record problems.
 * @returns The handles with their descriptors and aliases, in declaration order.
 */
function resourceEntries(value: unknown, problems: DeclarationProblems): Array<readonly [object, ResourceDescriptor, string]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.invalid("\"resources\" must be an object of resource handles keyed by alias.");
    return [];
  }
  const entries: Array<readonly [object, ResourceDescriptor, string]> = [];
  for (const [alias, handle] of Object.entries(value)) {
    const resource = getResourceDescriptor(handle);
    if (resource === undefined) {
      if (typeof handle === "object" && handle !== null && descriptorKey in handle)
        problems.invalid(`resources.${alias} carries a Holqa descriptor that this version of @holqa/core does not support (another protocol version or an unknown resource kind).`, "Use one version of @holqa/sdk and @holqa/core throughout the application.");
      else
        problems.invalid(`resources.${alias} is not a Holqa resource.`, "Declare resources with the SDK's factories, such as queue(...) or bucket(...).");
      continue;
    }
    const owner = currentOwner(handle as object);
    if (owner !== undefined) {
      problems.invalid(`resources.${alias} ("${resource.id}") already belongs to application "${owner.name}".`, "A resource handle belongs to exactly one application instance. Declare the resource once per application.");
      continue;
    }
    entries.push([handle as object, resource, alias]);
  }
  problems.add(checkIdentities(entries.map(([, resource, alias]) => ({ id: resource.id, label: `resources.${alias}` })), "resource"));
  return entries;
}

/**
 * Checks the `env` record and builds a configuration descriptor per entry.
 *
 * @param value - The `env` option, unvalidated.
 * @param problems - Where to record problems.
 * @returns The configuration descriptors, in declaration order.
 */
function configEntries(value: unknown, problems: DeclarationProblems): ConfigDescriptor[] {
  if (value === undefined)
    return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.invalid("\"env\" must be an object of secret(...) and variable(...) entries keyed by name.");
    return [];
  }
  const descriptors: ConfigDescriptor[] = [];
  for (const [name, entry] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    if (!envNamePattern.test(name))
      problems.invalid(`env.${name}: names must start with a letter or "_" and contain only letters, digits and "_".`);
    if (!isConfigEntry(entry)) {
      problems.invalid(`env.${name} is not a configuration entry.`, "Declare entries with secret(schema) or variable(schema).");
      continue;
    }
    descriptors.push(Object.freeze({
      protocol: descriptorProtocol,
      type: "config" as const,
      name,
      sensitive: entry.sensitive,
      schema: entry.schema,
      ...(entry.defaultValue === undefined ? {} : { defaultValue: entry.defaultValue })
    }));
  }
  return descriptors;
}

/**
 * Reports whether a value is a configuration entry created by `secret` or `variable`.
 *
 * @param value - The candidate entry.
 * @returns `true` for a structurally valid entry.
 */
function isConfigEntry(value: unknown): value is AnyConfigEntry {
  return typeof value === "object" && value !== null
    && "kind" in value && (value.kind === "secret" || value.kind === "variable")
    && "sensitive" in value && value.sensitive === (value.kind === "secret")
    && "schema" in value && isStandardSchema(value.schema);
}