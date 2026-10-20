import type {
  AppDescriptor,
  BindingProvider,
  Diagnostic,
  JsonObject,
  ProviderContext,
  ProviderInstance,
  ProviderTopology
} from "@holqa/core";
import type { EnvironmentVariables } from "@holqa/runtime-bun";

import type { Clock } from "@/clock";
import type {
  LocalEnvironmentOptions,
  LocalState
} from "@/environment";
import type { LocalTelemetryStore } from "@/telemetry/telemetry-store";

import {
  bindingFailure,
  bindingProtocolVersion,
  createDiagnostic,
  diagnosticCodes,
  HolqaError
} from "@holqa/core";

import {
  localCapabilities,
  openLocalState
} from "@/environment";
import { createLocalTelemetryStore } from "@/telemetry/telemetry-store";

/** How local state is kept: SQLite and files in a directory (development), or memory (fast, isolated tests). */
export type LocalPersistence = "sqlite" | "memory";

/** Settings of the local binding providers. */
export interface LocalBindingOptions {
  /** The platform provider's name; the per-kind providers append `.queues`, `.buckets` and `.schedules`. Default `local`. */
  readonly name?: string;
  /**
   * `sqlite` (default) keeps queue, event, object and schedule state in
   * `directory` and survives restarts; `memory` keeps everything in the
   * process and loses it when the binding stops. Memory state is not durable:
   * use it for tests, never to stand in for production durability.
   */
  readonly persistence?: LocalPersistence;
  /** Where `sqlite` state is kept, relative to the working directory. Default `.holqa/local`. Ignored for `memory`. */
  readonly directory?: string;
  /** Configuration values and credentials. Defaults to `process.env` when the binding starts. */
  readonly env?: EnvironmentVariables;
  /** The time source for delays, leases, signed URL expiry and schedules. Defaults to the wall clock. */
  readonly clock?: Clock;
  /** Creates message, event, run and lease identifiers. Defaults to `crypto.randomUUID`. */
  readonly createId?: () => string;
  readonly queues?: LocalEnvironmentOptions["queues"];
  readonly storage?: LocalEnvironmentOptions["storage"];
  /** Whether the platform supplies the local telemetry store as its telemetry exporter. Default `true`. */
  readonly telemetry?: boolean;
}

/** The local state and telemetry store while a local provider is open. */
export interface OpenedLocalState extends LocalState {
  /** The local telemetry store, when the platform supplies telemetry. */
  readonly telemetry?: LocalTelemetryStore;
}

/** The kinds and services of the local platform. */
type PlatformKinds = "queue" | "bucket" | "schedule" | "http.api";

/** The services of the local platform. */
type PlatformServices = "config" | "telemetry" | "idempotency" | "operation-budgets";

/**
 * The local binding providers of one state directory (or one in-memory
 * state). They share the state: whichever opens first opens it, and the last
 * one to stop closes it, so a configuration can select the platform for some
 * resources and `queues()` for others without two copies of the state.
 */
export interface LocalProviders {
  /** A complete platform: every resource kind, configuration, telemetry and the event safety stores. */
  readonly platform: () => BindingProvider<PlatformKinds, PlatformServices>;
  /** Queues only. */
  readonly queues: () => BindingProvider<"queue">;
  /** Buckets with object events and development signed URLs only. */
  readonly buckets: () => BindingProvider<"bucket">;
  /** Schedules only. */
  readonly schedules: () => BindingProvider<"schedule">;
  /** The opened state, for inspection (`queues.messages`, `storage.objects`, `settle`, ...), while any of these providers is open. */
  readonly state: () => OpenedLocalState | undefined;
}

/**
 * Creates the local binding providers for one state directory (or memory).
 * Creating them opens nothing: the state is opened when a runtime starts a
 * binding that selected one of them. Settings are validated here.
 *
 * @example
 * ```ts
 * const env = localEnvironment({ persistence: "sqlite", directory: ".holqa/local" });
 * export default defineBindings(app, { defaults: env.platform(), kinds: { queue: brokerQueues } });
 * ```
 *
 * @param options - Persistence, directory, configuration source, clock and settings.
 * @returns The providers, sharing one state.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID`, one diagnostic per invalid setting.
 */
export function localEnvironment(options: LocalBindingOptions = {}): LocalProviders {
  checkProviderOptions(options);
  const name = options.name ?? "local";
  const persistence = options.persistence ?? "sqlite";
  const directory = persistence === "memory" ? undefined : options.directory ?? ".holqa/local";
  const topology: ProviderTopology = Object.freeze({ delivery: "pull", state: persistence === "memory" ? "process" : "host" });
  const settings: JsonObject = Object.freeze({
    persistence,
    ...directory === undefined ? {} : { directory },
    ...options.env === undefined ? { configSource: "environment" } : { configSource: "values" }
  });
  let opened: { readonly app: AppDescriptor; readonly state: OpenedLocalState; users: number } | undefined;

  /**
   * Opens the shared state, or joins it when another provider opened it.
   *
   * @param context - The provider context.
   * @param withTelemetry - Whether to open the telemetry store too.
   * @returns The state.
   * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` when another application already opened it, or the local state's own failures.
   */
  const acquire = (context: ProviderContext, withTelemetry: boolean): OpenedLocalState => {
    if (opened !== undefined) {
      if (opened.app !== context.app)
        throw new HolqaError(bindingFailure("configuration", { binding: name, message: `The local state "${directory ?? "memory"}" is already open for the application "${opened.app.name}".`, hint: "Give each application its own local environment." }));
      opened.users += 1;
      return opened.state;
    }
    const state = openLocalState(context.app, {
      directory,
      ...options.clock === undefined ? {} : { clock: options.clock },
      ...options.createId === undefined ? {} : { createId: options.createId },
      ...options.queues === undefined ? {} : { queues: options.queues },
      ...options.storage === undefined ? {} : { storage: options.storage }
    });
    let telemetry: LocalTelemetryStore | undefined;
    try {
      telemetry = withTelemetry && options.telemetry !== false ? createLocalTelemetryStore({ directory, ...options.clock === undefined ? {} : { clock: options.clock } }) : undefined;
    } catch (error) {
      state.close();
      throw error;
    }
    opened = { app: context.app, state: Object.freeze({ ...state, ...telemetry === undefined ? {} : { telemetry } }), users: 1 };
    context.log("debug", "local state opened", { persistence, ...directory === undefined ? {} : { directory } });
    return opened.state;
  };
  /** Leaves the shared state, closing it when the last provider stops. */
  const release = (): void => {
    if (opened === undefined)
      return;
    opened.users -= 1;
    if (opened.users > 0)
      return;
    const { state } = opened;
    opened = undefined;
    state.telemetry?.close();
    state.close();
  };
  /**
   * Builds the lifecycle part of an instance.
   *
   * @returns Health and stop hooks.
   */
  const lifecycle = (): Pick<ProviderInstance, "health" | "stop"> => {
    let stopped = false;
    return {
      health: async () => ({ status: "healthy", details: { persistence } }),
      stop: async () => {
        if (stopped)
          return;
        stopped = true;
        release();
      }
    };
  };
  /**
   * Describes one local provider.
   *
   * @param suffix - Appended to the platform name, empty for the platform.
   * @param role - `platform` or `resource`.
   * @param declaration - Contracts, capabilities and services.
   * @param open - Builds the instance from the shared state.
   * @returns The frozen provider.
   */
  const provider = <Provider extends BindingProvider<never, never>>(suffix: string, role: "platform" | "resource", declaration: Pick<Provider, "contracts" | "resources" | "services"> & Partial<Pick<Provider, "execution">>, open: (context: ProviderContext) => ProviderInstance): Provider => Object.freeze({
    bindingProtocol: bindingProtocolVersion,
    provider: "holqa.local",
    name: `${name}${suffix}`,
    role,
    ...declaration,
    topology,
    settings,
    open: async (context: ProviderContext) => open(context)
  }) as unknown as Provider;

  const queueCapabilities = localCapabilities.queue!;
  const bucketCapabilities = localCapabilities.bucket!;
  const scheduleCapabilities = localCapabilities.schedule!;
  const platform = provider<BindingProvider<PlatformKinds, PlatformServices>>("", "platform", {
    contracts: Object.freeze({ "execution": 1, "http.api": 1, "queue": 1, "bucket": 1, "bucket.events": 1, "schedule": 1, "config": 1, "telemetry": 1, "idempotency": 1, "operation-budgets": 1 }),
    resources: Object.freeze({ "queue": queueCapabilities, "bucket": bucketCapabilities, "schedule": scheduleCapabilities, "http.api": Object.freeze({}) }),
    services: Object.freeze({ "config": true, "telemetry": true, "idempotency": true, "operation-budgets": true }),
    execution: Object.freeze({ runtimes: Object.freeze(["bun"]), mode: "long-running" })
  }, (context) => {
    const state = acquire(context, true);
    const env = options.env ?? process.env;
    return Object.freeze({
      drivers: state.drivers,
      sources: state.sources,
      config: Object.freeze({ lookup: (key: string) => env[key] }),
      telemetry: Object.freeze(state.telemetry === undefined ? [] : [state.telemetry.exporter]),
      idempotency: state.idempotency,
      operationBudgets: state.operationBudgets,
      ...lifecycle()
    });
  });
  const queues = provider<BindingProvider<"queue">>(".queues", "resource", {
    contracts: Object.freeze({ queue: 1 }),
    resources: Object.freeze({ queue: queueCapabilities }),
    services: Object.freeze({})
  }, (context) => {
    const state = acquire(context, false);
    return Object.freeze({ drivers: Object.freeze({ queue: state.drivers.queue! }), sources: Object.freeze({ queue: state.sources.queue! }), ...lifecycle() });
  });
  const buckets = provider<BindingProvider<"bucket">>(".buckets", "resource", {
    contracts: Object.freeze({ "bucket": 1, "bucket.events": 1 }),
    resources: Object.freeze({ bucket: bucketCapabilities }),
    services: Object.freeze({})
  }, (context) => {
    const state = acquire(context, false);
    return Object.freeze({ drivers: Object.freeze({ bucket: state.drivers.bucket! }), sources: Object.freeze({ bucket: state.sources.bucket! }), ...lifecycle() });
  });
  const schedules = provider<BindingProvider<"schedule">>(".schedules", "resource", {
    contracts: Object.freeze({ schedule: 1 }),
    resources: Object.freeze({ schedule: scheduleCapabilities }),
    services: Object.freeze({})
  }, (context) => {
    const state = acquire(context, false);
    return Object.freeze({ sources: Object.freeze({ schedule: state.sources.schedule! }), ...lifecycle() });
  });
  return Object.freeze({
    platform: () => platform,
    queues: () => queues,
    buckets: () => buckets,
    schedules: () => schedules,
    state: () => opened?.state
  });
}

/**
 * The local binding providers, as provider factories. Each call creates a
 * separate local environment; use {@link localEnvironment} to share one state
 * between the platform and per-kind providers.
 */
export const local = Object.freeze({
  /** The local providers of one state, sharing it. */
  environment: localEnvironment,
  /**
   * A complete local platform.
   *
   * @param options - Persistence, directory and settings.
   * @returns The platform provider.
   */
  platform: (options: LocalBindingOptions = {}) => localEnvironment(options).platform(),
  /**
   * Local queues only.
   *
   * @param options - Persistence, directory and settings.
   * @returns A queue provider.
   */
  queues: (options: LocalBindingOptions = {}) => localEnvironment(options).queues(),
  /**
   * Local buckets only.
   *
   * @param options - Persistence, directory and settings.
   * @returns A bucket provider.
   */
  buckets: (options: LocalBindingOptions = {}) => localEnvironment(options).buckets(),
  /**
   * Local schedules only.
   *
   * @param options - Persistence, directory and settings.
   * @returns A schedule provider.
   */
  schedules: (options: LocalBindingOptions = {}) => localEnvironment(options).schedules()
});

/**
 * Validates the settings of the local providers, so a typo fails when the
 * binding configuration is defined rather than when it starts.
 *
 * @param options - The untrusted settings.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID`, one diagnostic per invalid setting.
 */
function checkProviderOptions(options: LocalBindingOptions): void {
  const problems: Diagnostic[] = [];
  /**
   * Records one problem.
   *
   * @param message - What is wrong.
   */
  const invalid = (message: string): void => {
    problems.push(createDiagnostic({ code: diagnosticCodes.bindingConfigInvalid, severity: "error", message: `The local binding setting ${message}` }));
  };
  /**
   * Records a problem unless a value is absent or a positive safe integer.
   *
   * @param value - The candidate.
   * @param setting - The setting's name.
   */
  const positive = (value: unknown, setting: string): void => {
    if (value !== undefined && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 1))
      invalid(`"${setting}" must be an integer of at least 1.`);
  };
  if (options.persistence !== undefined && options.persistence !== "sqlite" && options.persistence !== "memory")
    invalid("\"persistence\" must be \"sqlite\" or \"memory\".");
  if (options.directory !== undefined && (typeof options.directory !== "string" || options.directory === ""))
    invalid("\"directory\" must be a non-empty path.");
  if (options.name !== undefined && !(typeof options.name === "string" && /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/.test(options.name)))
    invalid("\"name\" must be lowercase letters, digits and hyphens, in dot-separated segments.");
  positive(options.queues?.defaultMaxAttempts, "queues.defaultMaxAttempts");
  positive(options.queues?.pollIntervalMs, "queues.pollIntervalMs");
  positive(options.queues?.retentionMs, "queues.retentionMs");
  positive(options.storage?.maxUploadBytes, "storage.maxUploadBytes");
  const base = options.storage?.signedUrlBase;
  if (base !== undefined && !(typeof base === "string" && URL.canParse(base) && /^https?:$/.test(new URL(base).protocol)))
    invalid("\"storage.signedUrlBase\" must be an absolute http or https URL.");
  if (problems.length > 0)
    throw new HolqaError(problems);
}