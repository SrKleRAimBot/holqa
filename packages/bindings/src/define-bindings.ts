import type {
  AnyBindingProvider,
  AppDescriptor,
  BindingProvider,
  BindingServiceName,
  ResourceKind
} from "@holqa/core";

import {
  createDiagnostic,
  descriptorKey,
  diagnosticCodes,
  getAppDescriptor,
  HolqaError
} from "@holqa/core";

/**
 * The structural view of an application that binding configurations are
 * typed against: its resource handles, each with a literal `kind` and `id`.
 * An application created with `defineApp` from `@holqa/sdk` satisfies it.
 */
export interface BindableApp {
  readonly resources: Readonly<Record<string, { readonly kind: ResourceKind; readonly id: string }>>;
}

/** Every resource handle of an application. */
type Handles<App extends BindableApp> = App["resources"][keyof App["resources"]];

/** The identifiers of an application's resources. */
export type ResourceIdsOf<App extends BindableApp> = Handles<App>["id"];

/** The resource kinds an application declares. */
export type ResourceKindsOf<App extends BindableApp> = Handles<App>["kind"];

/** The kind of the resource with an identifier. */
export type KindOfResource<App extends BindableApp, Id> = Extract<Handles<App>, { readonly id: Id }>["kind"];

/**
 * Providers selected for individual resources, keyed by resource identifier.
 * Each must bind the resource's kind.
 */
export type ResourceBindings<App extends BindableApp> = {
  readonly [Id in ResourceIdsOf<App>]?: BindingProvider<KindOfResource<App, Id>>;
};

/** Providers selected for every resource of a kind, keyed by kind. Each must bind that kind. */
export type KindBindings<App extends BindableApp> = {
  readonly [Kind in ResourceKindsOf<App>]?: BindingProvider<Kind>;
};

/** One provider for a service, or an ordered list where the service combines several. */
export type ServiceSelection<Service extends BindingServiceName> = BindingProvider<never, Service> | readonly BindingProvider<never, Service>[];

/**
 * Providers selected for cross-cutting services. `config` is an ordered
 * list of sources (the first that has a value wins); `telemetry` exports to
 * every listed provider; `idempotency` and `operation-budgets` take one
 * provider each.
 */
export interface ServiceBindings {
  readonly "config"?: ServiceSelection<"config">;
  readonly "telemetry"?: ServiceSelection<"telemetry">;
  readonly "idempotency"?: BindingProvider<never, "idempotency">;
  readonly "operation-budgets"?: BindingProvider<never, "operation-budgets">;
}

/**
 * Which provider fulfils each resource and service of an application in one
 * environment. Resolution precedence for a resource is fixed: its entry in
 * `resources`, then its kind's entry in `kinds`, then `defaults`.
 *
 * @typeParam App - The application, as `defineApp` returns it.
 */
export interface BindingsConfig<App extends BindableApp> {
  /** The configuration's name, for example `local` or `production`. Default `default`. */
  readonly name?: string;
  /** The platform default: binds every resource and service not selected otherwise, as far as it can. */
  readonly defaults?: AnyBindingProvider;
  /** Providers for every resource of a kind. */
  readonly kinds?: KindBindings<App>;
  /** Providers for individual resources, by identifier. */
  readonly resources?: ResourceBindings<App>;
  /** Providers for cross-cutting services. */
  readonly services?: ServiceBindings;
  /**
   * Providers of extensions. For each extension the application uses, the
   * first listed provider that implements it is selected; without one, the
   * default provider when it implements it.
   */
  readonly extensions?: readonly AnyBindingProvider[];
}

/** A compile-time error carried as a type, so the message appears in the editor. */
export interface BindingsTypeError<Message extends string> {
  readonly "~holqaBindingsError": Message;
}

/** Resource identifiers selected in `resources` that the application does not declare. */
type UnknownIds<App extends BindableApp, Config> = Config extends { readonly resources: infer Selected } ? Exclude<keyof Selected, ResourceIdsOf<App>> : never;

/** Kinds selected in `kinds` that are not resource kinds the application declares. */
type UnknownKinds<App extends BindableApp, Config> = Config extends { readonly kinds: infer Selected } ? Exclude<keyof Selected, ResourceKindsOf<App>> : never;

/** Identifiers of resources whose kind has an entry in `kinds`. */
type IdsOfKinds<App extends BindableApp, Kinds> = Extract<Handles<App>, { readonly kind: Kinds }>["id"];

/** Resources with no provider when the configuration has no `defaults`. */
type Uncovered<App extends BindableApp, Config> = Config extends { readonly defaults: AnyBindingProvider }
  ? never
  : Exclude<
    ResourceIdsOf<App>,
    (Config extends { readonly resources: infer Selected } ? keyof Selected : never) | IdsOfKinds<App, Config extends { readonly kinds: infer Selected } ? keyof Selected : never>
  >;

/**
 * Resolves to `unknown` for a configuration that can be complete, and to a
 * {@link BindingsTypeError} naming undeclared resources, undeclared kinds or
 * resources without any provider otherwise. Run-time validation checks the
 * same and more (for example that a default platform really binds every kind).
 *
 * @typeParam App - The application.
 * @typeParam Config - The configuration as written.
 */
export type CheckBindings<App extends BindableApp, Config> = [UnknownIds<App, Config>] extends [never]
  ? [UnknownKinds<App, Config>] extends [never]
    ? [Uncovered<App, Config>] extends [never]
      ? unknown
      : BindingsTypeError<`Resource "${Uncovered<App, Config> & string}" has no provider: select one in "resources" or "kinds", or set "defaults".`>
    : BindingsTypeError<`"kinds" selects a provider for "${UnknownKinds<App, Config> & string}", a kind the application does not declare.`>
  : BindingsTypeError<`"resources" selects a provider for "${UnknownIds<App, Config> & string}", which the application does not declare.`>;

/**
 * A binding configuration, as `defineBindings` returns it: the application
 * descriptor and the selections, frozen. Creating one opens no connection.
 *
 * @typeParam App - The application it binds.
 */
export interface BindingsDefinition<App extends BindableApp = BindableApp> {
  readonly "type": "holqa.bindings";
  readonly "name": string;
  /** The application's descriptor. */
  readonly "app": AppDescriptor;
  readonly "defaults"?: AnyBindingProvider;
  readonly "kinds": Readonly<Partial<Record<ResourceKind, AnyBindingProvider>>>;
  readonly "resources": Readonly<Record<string, AnyBindingProvider>>;
  readonly "services": ServiceBindings;
  readonly "extensions": readonly AnyBindingProvider[];
  /** Phantom marker that keeps the application's type for tools; never set. */
  readonly "~app"?: App;
}

/** Matches a configuration name: lowercase segments of letters, digits and hyphens. */
const namePattern = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;

/**
 * Declares which provider fulfils each resource and service of an
 * application in one environment, for example local development or
 * production. Business logic never changes between configurations: handlers
 * use the same typed handles whatever binds them.
 *
 * Pure: creates no connection and reads no environment. Selections are
 * type-checked against the application (unknown resource identifiers, a
 * provider that does not bind a resource's kind, resources without any
 * provider), and the shape is checked at run time; whether providers satisfy
 * every requirement is checked by `resolveBindings` and when a runtime starts.
 *
 * @example
 * ```ts
 * import { defineBindings } from "@holqa/bindings";
 * import { local } from "@holqa/local";
 * import app from "./infra";
 *
 * export default defineBindings(app, {
 *   name: "local",
 *   defaults: local.platform()
 * });
 * ```
 *
 * @param app - The application, as `defineApp` returns it.
 * @param config - The selections.
 * @returns The frozen binding configuration.
 * @throws {HolqaError} `HOLQA_APP_INVALID` when `app` is not a Holqa application, or `HOLQA_BINDING_CONFIG_INVALID` for a malformed configuration (one diagnostic per problem).
 */
export function defineBindings<const App extends BindableApp, const Config extends BindingsConfig<App>>(app: App, config: Config & CheckBindings<App, Config>): BindingsDefinition<App> {
  const descriptor = getAppDescriptor(app);
  if (descriptor === undefined)
    throw new HolqaError(createDiagnostic({ code: diagnosticCodes.appInvalid, severity: "error", message: "defineBindings was given a value that is not a Holqa application.", hint: "Pass the default export of the application's infra.ts, created with defineApp." }));
  const input = config as BindingsConfig<App>;
  const problems: string[] = [];
  if (typeof input !== "object" || input === null)
    throw invalid(["the configuration must be an object."]);
  for (const key of Object.keys(input)) {
    if (!["name", "defaults", "kinds", "resources", "services", "extensions"].includes(key))
      problems.push(`"${key}" is not a binding configuration setting.`);
  }
  const name = input.name ?? "default";
  if (typeof name !== "string" || !namePattern.test(name))
    problems.push("\"name\" must be lowercase letters, digits and hyphens, in dot-separated segments.");
  /**
   * Reads an optional record-valued setting, reporting a non-object.
   *
   * @param value - The setting's value.
   * @param field - The setting's name, for messages.
   * @returns The record, or an empty one.
   */
  const record = (value: unknown, field: string): Readonly<Record<string, unknown>> => {
    if (value === undefined)
      return {};
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return value as Readonly<Record<string, unknown>>;
    problems.push(`"${field}" must be an object.`);
    return {};
  };
  const kinds = record(input.kinds, "kinds");
  const resources = record(input.resources, "resources");
  const services = record(input.services, "services");
  const extensions: unknown = input.extensions ?? [];
  if (!Array.isArray(extensions))
    problems.push("\"extensions\" must be a list of providers.");
  for (const key of Object.keys(services)) {
    if (!["config", "telemetry", "idempotency", "operation-budgets"].includes(key))
      problems.push(`"services.${key}" is not a service; the services are config, telemetry, idempotency and operation-budgets.`);
  }
  if (problems.length > 0)
    throw invalid(problems);
  return Object.freeze({
    type: "holqa.bindings",
    name,
    app: descriptor,
    ...input.defaults === undefined ? {} : { defaults: input.defaults },
    kinds: Object.freeze({ ...kinds }) as BindingsDefinition<App>["kinds"],
    resources: Object.freeze({ ...resources }) as BindingsDefinition<App>["resources"],
    services: Object.freeze(Object.fromEntries(Object.entries(services).map(([key, value]) => [key, Array.isArray(value) ? Object.freeze([...value]) : value]))) as ServiceBindings,
    extensions: Object.freeze([...extensions as readonly AnyBindingProvider[]])
  });
}

/**
 * Reports whether a value is a binding configuration created by
 * `defineBindings`, for example the default export of a `bindings.ts` module.
 *
 * @param value - The candidate.
 * @returns `true` for a binding configuration.
 */
export function isBindingsDefinition(value: unknown): value is BindingsDefinition {
  return typeof value === "object" && value !== null
    && (value as { readonly type?: unknown }).type === "holqa.bindings"
    && getAppDescriptor({ [descriptorKey]: (value as { readonly app?: unknown }).app }) !== undefined;
}

/**
 * Builds the error for a malformed configuration.
 *
 * @param problems - One sentence per problem.
 * @returns A Holqa error with one `HOLQA_BINDING_CONFIG_INVALID` diagnostic per problem.
 */
function invalid(problems: readonly string[]): HolqaError {
  return new HolqaError(problems.map(problem => createDiagnostic({ code: diagnosticCodes.bindingConfigInvalid, severity: "error", message: `defineBindings: ${problem}` })));
}