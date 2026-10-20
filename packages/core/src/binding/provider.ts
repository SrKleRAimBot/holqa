import type { AppDescriptor } from "@/app/app-descriptor";
import type {
  BindingContractName,
  BindingProtocolVersion
} from "@/binding/contracts";
import type {
  BindingLogLevel,
  BindingStopOptions,
  ComponentHealth
} from "@/binding/lifecycle";
import type { OperationBudgetStore } from "@/binding/operation-budgets";
import type { ResourceDrivers } from "@/binding/runtime-binding";
import type { ResourceSources } from "@/binding/sources";
import type { ExtensionReference } from "@/extensions/extension";
import type { IdempotencyStore } from "@/idempotency/idempotency-store";
import type { JsonObject } from "@/json";
import type { TelemetryExporter } from "@/observability/telemetry";
import type {
  ResourceKind,
  ResourceKindMap
} from "@/resources/kinds";
import type { ResourceDescriptor } from "@/resources/resource-descriptor";

import { bindingProtocolVersion } from "@/binding/contracts";
import { diagnosticCodes } from "@/diagnostics/codes";
import { failWith } from "@/errors/holqa-error";

// A provider is a declarative, side-effect-free description of one binding
// implementation, plus an `open` function that connects it. Everything a
// tool needs to validate a selection (which resource kinds and services it
// binds, which contract versions it implements, what it advertises, which
// credentials and background processes it needs) is plain data available
// without connecting, so `holqa bindings validate` never needs network access
// or credentials. Only `open` touches infrastructure.

/**
 * What a provider is for:
 *
 * - `platform`: implements every mandatory contract (`mandatoryBindingContracts`), so it can run a complete application on its own;
 * - `resource`: binds one or more resource kinds, for example only queues;
 * - `service`: supplies cross-cutting services (configuration, telemetry, event safety stores) without binding resources.
 */
export type ProviderRole = "platform" | "resource" | "service";

/** The cross-cutting services a provider may supply. */
export type BindingServiceName = "config" | "telemetry" | "idempotency" | "operation-budgets";

/**
 * A reference to a credential, such as a connection URL or an access key,
 * resolved when a binding starts through the configuration service (by
 * default, environment variables). Binding settings and manifests contain
 * only the reference, never the value.
 */
export interface CredentialReference {
  readonly type: "credential";
  /** The name the configuration service resolves, for example `QUEUE_URL`. */
  readonly name: string;
}

/**
 * How a provider fulfils a capability that its infrastructure lacks natively,
 * for example delayed redelivery through dedicated delay queues. Emulation
 * must be enabled explicitly in the provider's settings and is reported by
 * binding inspection, because it has operational consequences (extra
 * infrastructure, different failure modes) that a native capability lacks.
 */
export interface CapabilityEmulation {
  /** The resource kind the emulated capability belongs to. */
  readonly kind: ResourceKind;
  /** The capability, in the required-capability vocabulary, for example `queue.backoff.exponential`. */
  readonly capability: string;
  /** How it is emulated, in one sentence. */
  readonly mechanism: string;
  /** Infrastructure the emulation needs beyond the resource itself, for example `a delay queue per redelivery delay`. */
  readonly requires?: readonly string[];
}

/** What a host that runs the invocation engine advertises. */
export interface ExecutionCapabilities {
  /** Runtimes the host can run, for example `bun`. */
  readonly runtimes: readonly string[];
  /**
   * `long-running`: application processes stay up and can consume sources
   * (pull queue messages, receive scheduled runs) in the background.
   * `request-driven`: processes run only while serving requests, so
   * background delivery needs a provider that pushes events or a separately
   * deployed worker.
   */
  readonly mode: "long-running" | "request-driven";
  /** The longest invocation time limit the host allows, in milliseconds. Absent means no limit. */
  readonly maxTimeoutMs?: number;
  /** The most concurrent invocations per process the host allows. Absent means no limit. */
  readonly maxConcurrency?: number;
}

/**
 * How a provider takes part in a deployment's topology. Used to reject
 * deployments that would silently lose events, for example a process-local
 * scheduler in a deployment with several replicas.
 */
export interface ProviderTopology {
  /**
   * How the provider's sources deliver events: `pull` (the runtime leases
   * deliveries from a long-running process), `push` (the infrastructure calls
   * the application), or `none` (the provider delivers no events).
   */
  readonly delivery: "pull" | "push" | "none";
  /**
   * Where the provider's state lives: `process` (in one process's memory),
   * `host` (in files on one machine, shared by processes there), or `shared`
   * (in infrastructure every replica reaches).
   */
  readonly state: "process" | "host" | "shared";
  /** Background processes or connectors the provider needs besides the application process, described for operators. */
  readonly connectors?: readonly string[];
}

/** What a provider receives when it is opened. */
export interface ProviderContext {
  /** The application being bound. */
  readonly app: AppDescriptor;
  /** The name of the binding configuration, for example `local` or `production`. */
  readonly environment: string;
  /** The resources this provider was selected for, sorted by identifier. Empty for service providers. */
  readonly resources: readonly ResourceDescriptor[];
  /**
   * Resolves a credential reference through the configuration service.
   *
   * @throws {HolqaError} `HOLQA_BINDING_CREDENTIALS_MISSING` when the credential is not set. Its value is never logged.
   */
  readonly credential: (reference: CredentialReference) => string;
  /** Aborted when the start exceeded its time limit or the runtime is stopping. */
  readonly signal: AbortSignal;
  /** Writes a structured log entry attributed to the provider. Fields are redacted like every runtime log. */
  readonly log: (level: BindingLogLevel, message: string, fields?: JsonObject) => void;
}

/**
 * A source of configuration values and credentials, by name. Values are raw
 * strings, as environment variables and secret files hold them; Holqa applies
 * declared defaults and validates every value against its schema, the same
 * way for every source.
 */
export interface ConfigSource {
  /** Returns the value with this name, or `undefined` when the source has none. */
  readonly lookup: (name: string) => string | undefined;
  /**
   * Reads the values again, for example after a secret was rotated. Optional.
   * Configuration entries already validated by a running application keep
   * their values; credentials resolved afterwards (for example when a driver
   * reconnects) see the new ones.
   */
  readonly refresh?: () => Promise<void>;
}

/**
 * An opened provider: the drivers, sources and services it supplies, and its
 * part of the binding lifecycle. Only the parts the provider declared are
 * used; supplying a driver for a kind it does not declare has no effect.
 */
export interface ProviderInstance {
  readonly drivers?: ResourceDrivers;
  readonly sources?: ResourceSources;
  readonly config?: ConfigSource;
  readonly telemetry?: readonly TelemetryExporter[];
  readonly idempotency?: IdempotencyStore;
  readonly operationBudgets?: OperationBudgetStore;
  /** The implementations of the extensions the provider declares, by identifier. */
  readonly extensions?: Readonly<Record<string, unknown>>;
  /** Resolves once the provider can serve operations; rejects with a classified binding failure. */
  readonly ready?: (signal: AbortSignal) => Promise<void>;
  /** Reports the provider's health; `name` is filled in by the binding. Must not throw. */
  readonly health?: () => Promise<Omit<ComponentHealth, "name">>;
  /** Releases everything `open` acquired. Called once, also after a failed start. */
  readonly stop?: (options: BindingStopOptions) => Promise<void>;
}

/** One extension a provider implements, with what its definition requires. */
export interface ExtensionDeclaration extends ExtensionReference {
  /** Extensions the implementation needs, from the definition's `dependsOn`. */
  readonly dependsOn?: readonly ExtensionReference[];
  /** Runtimes the implementation runs in, from the definition's `runtimes`. Absent means any. */
  readonly runtimes?: readonly string[];
}

/** Capabilities by resource kind, every kind optional. */
type CapabilitiesByKind = { readonly [Kind in ResourceKind]?: ResourceKindMap[Kind]["capabilities"] };

/** Services by name, every service optional. */
type ServicesByName = { readonly [Service in BindingServiceName]?: true };

/**
 * One binding implementation. A provider is plain, side-effect-free data plus
 * `open`: creating one (for example `local.platform()`) never connects to
 * anything, so binding configurations can be validated and inspected without
 * credentials or network access.
 *
 * The type parameters record what a provider binds, so a binding
 * configuration can reject, at compile time, a bucket provider for a queue.
 *
 * @typeParam Kinds - Resource kinds the provider certainly binds; `never` for "any provider".
 * @typeParam Services - Services the provider certainly supplies.
 */
export interface BindingProvider<Kinds extends ResourceKind = never, Services extends BindingServiceName = never> {
  /** The provider protocol version, {@link bindingProtocolVersion}. */
  readonly bindingProtocol: BindingProtocolVersion;
  /**
   * The implementation's globally namespaced identifier, for example
   * `holqa.local` or `example.queue`: a reverse-domain or package-scoped
   * prefix, a dot, and a name, in resource identifier grammar.
   */
  readonly provider: string;
  /** This configured instance's name for diagnostics and manifests, for example `rabbitmq` or `rabbitmq.orders`. */
  readonly name: string;
  readonly role: ProviderRole;
  /** The version of each binding contract the provider implements. */
  readonly contracts: { readonly [Contract in BindingContractName]?: number };
  /** What the provider advertises for each resource kind it binds. A kind that is absent is not bound. */
  readonly resources: CapabilitiesByKind & { readonly [Kind in Kinds]: ResourceKindMap[Kind]["capabilities"] };
  /** The services the provider supplies. */
  readonly services: ServicesByName & { readonly [Service in Services]: true };
  /** What the provider advertises as an execution host. Required with the `execution` contract. */
  readonly execution?: ExecutionCapabilities;
  /** Capabilities fulfilled through an explicitly enabled compatibility layer rather than natively. */
  readonly emulations?: readonly CapabilityEmulation[];
  /** How the provider takes part in a deployment's topology. Absent means `{ delivery: "none", state: "shared" }`. */
  readonly topology?: ProviderTopology;
  /** The extensions the provider implements; its instance supplies them in `extensions`, keyed by identifier. */
  readonly extensions?: readonly ExtensionDeclaration[];
  /** Non-secret settings, recorded in binding manifests. Never contains credential values. */
  readonly settings?: JsonObject;
  /** The credentials the provider resolves when it starts, recorded in binding manifests by name only. */
  readonly credentials?: readonly CredentialReference[];
  /**
   * Connects the provider: resolves credentials, opens connections and
   * creates drivers and sources. Called once per runtime start.
   *
   * @throws {HolqaError} A classified binding failure (`bindingFailure`); never fall back to another provider.
   */
  readonly open: (context: ProviderContext) => Promise<ProviderInstance>;
}

/** Any binding provider, whatever it binds. */
export type AnyBindingProvider = BindingProvider<never, never>;

/** Matches a provider identifier: segments in resource identifier grammar separated by dots, at least two of them. */
const providerIdPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

/**
 * Reports whether a value has the shape of a binding provider of this
 * protocol version. Only the shape is checked; `validateProvider` checks the
 * declaration in depth.
 *
 * @param value - A candidate, typically read from a binding configuration module.
 * @returns `true` when the value looks like a provider.
 */
export function isBindingProvider(value: unknown): value is AnyBindingProvider {
  if (typeof value !== "object" || value === null)
    return false;
  const candidate = value as Partial<Record<keyof AnyBindingProvider, unknown>>;
  return candidate.bindingProtocol === bindingProtocolVersion
    && typeof candidate.provider === "string"
    && typeof candidate.name === "string"
    && typeof candidate.open === "function"
    && typeof candidate.contracts === "object" && candidate.contracts !== null
    && typeof candidate.resources === "object" && candidate.resources !== null
    && typeof candidate.services === "object" && candidate.services !== null;
}

/**
 * Reports whether a string is a valid provider identifier: lowercase
 * segments of letters, digits and hyphens separated by dots, at least two
 * segments, for example `holqa.local` or `example.edge-queue`.
 *
 * @param value - A candidate identifier.
 * @returns `true` when the identifier is valid.
 */
export function isProviderId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && providerIdPattern.test(value);
}

/** Matches a credential name: letters, digits and underscores, not starting with a digit, as environment variables are named. */
const credentialNamePattern = /^[A-Z_]\w*$/i;

/**
 * Creates a reference to a credential that the configuration service
 * resolves when a binding starts. Use it for every secret-bearing provider
 * setting, so that binding configurations and manifests never contain values.
 *
 * @example
 * ```ts
 * rabbitmq.queue({ url: credentialRef("QUEUE_URL"), queue: "orders" });
 * ```
 *
 * @param name - The credential's name, in environment variable grammar.
 * @returns A frozen credential reference.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` when the name is not a valid credential name.
 */
export function credentialRef(name: string): CredentialReference {
  if (typeof name !== "string" || !credentialNamePattern.test(name))
    failWith(diagnosticCodes.bindingConfigInvalid, `${JSON.stringify(name) ?? String(name)} is not a valid credential name.`, "Use letters, digits and underscores, not starting with a digit, as environment variables are named.");
  return Object.freeze({ type: "credential", name });
}

/**
 * Reports whether a value is a credential reference.
 *
 * @param value - A candidate, typically a provider setting.
 * @returns `true` for a well-formed credential reference.
 */
export function isCredentialReference(value: unknown): value is CredentialReference {
  return typeof value === "object" && value !== null
    && (value as { readonly type?: unknown }).type === "credential"
    && typeof (value as { readonly name?: unknown }).name === "string"
    && credentialNamePattern.test((value as { readonly name: string }).name);
}