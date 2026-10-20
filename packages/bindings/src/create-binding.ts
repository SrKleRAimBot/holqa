import type {
  AnyBindingProvider,
  BindingLogLevel,
  BindingStartOptions,
  BindingStopOptions,
  ComponentHealth,
  ConfigDescriptor,
  ConfigSource,
  CredentialReference,
  Diagnostic,
  DrivenResourceKind,
  IdempotencyStore,
  JsonObject,
  OperationBudgetStore,
  ProviderInstance,
  ResourceDescriptor,
  ResourceDescriptorOf,
  ResourceDrivers,
  ResourceKind,
  ResourceSources,
  RuntimeBinding,
  TelemetryExporter
} from "@holqa/core";

import type {
  ResolvedBindings,
  ResourceSelection
} from "@/resolve";

import {
  bindingFailure,
  combineHealth,
  diagnosticCodes,
  diagnosticsOf,
  failWith,
  HolqaError,
  resolveConfiguration
} from "@holqa/core";

import { assertResolved } from "@/resolve";

/** Where a composed binding is in its lifecycle. */
type Phase = "idle" | "starting" | "started" | "stopping" | "stopped";

/** A provider that has been opened, with its instance. */
interface Opened {
  readonly provider: AnyBindingProvider;
  readonly instance: ProviderInstance;
}

/**
 * Composes a resolved binding configuration into the one `RuntimeBinding` a
 * runtime installs. Each resource's drivers and sources come from the
 * provider selected for it, `describe` reports that provider's capabilities
 * so every requirement is checked against the right provider, and services
 * (configuration, telemetry, event safety stores) come from their providers.
 *
 * The binding has a lifecycle the runtime drives: `start` opens every
 * selected provider once, in a fixed order (configuration first, then other
 * services, then resource providers), resolves credentials and validates
 * every configuration entry; `ready`, `health` and `stop` are forwarded to
 * every provider (`stop` in reverse order). A provider that fails to open
 * fails the start: the providers already opened are stopped, and nothing
 * falls back to another provider. Drivers and configuration used before
 * `start` completes fail with `HOLQA_RUNTIME_NOT_RUNNING`.
 *
 * @example
 * ```ts
 * const binding = createBinding(resolveBindings(bindings));
 * const runtime = createRuntime({ app, handlers, binding });
 * await runtime.start(); // starts the binding first
 * ```
 *
 * @param resolved - A resolution from `resolveBindings`.
 * @returns The composed binding, not yet started.
 * @throws {HolqaError} The resolution's error diagnostics, when it has any.
 */
export function createBinding(resolved: ResolvedBindings): RuntimeBinding {
  assertResolved(resolved);
  const { app } = resolved;
  const selections = new Map(resolved.resources.map(selection => [selection.resource.id as string, selection]));
  const opened = new Map<AnyBindingProvider, ProviderInstance>();
  const order: Opened[] = [];
  let phase: Phase = "idle";
  let values: ReadonlyMap<string, unknown> = new Map();
  let configSources: readonly ConfigSource[] = [];
  /** Writes provider logs; replaced by the runtime's logger when the binding starts. */
  let log: BindingStartOptions["log"] = () => {};
  const secrets = new Set<string>();

  /**
   * Returns the opened instance that serves a resource.
   *
   * @param resource - The resource whose provider is looked up.
   * @param operation - What was attempted, for messages.
   * @returns The selection and the opened instance.
   * @throws {HolqaError} `HOLQA_RUNTIME_NOT_RUNNING` before the binding has started, `HOLQA_BINDING_MISSING` for an unknown resource.
   */
  const serving = (resource: ResourceDescriptor, operation: string): { readonly selection: ResourceSelection; readonly instance: ProviderInstance } => {
    const selection = selections.get(resource.id);
    if (selection === undefined)
      failWith(diagnosticCodes.bindingMissing, `The binding "${resolved.name}" has no provider for the ${resource.kind} "${resource.id}".`);
    const instance = opened.get(selection.provider);
    if (phase !== "started" || instance === undefined)
      failWith(diagnosticCodes.runtimeNotRunning, `${operation} was used while the binding "${resolved.name}" is ${phase === "started" ? "starting" : phase}.`, "Start the runtime first; it starts its binding.");
    return { selection, instance };
  };
  /**
   * Returns the driver a provider supplied for a resource.
   *
   * @param resource - The resource the operation acts on.
   * @returns The provider's driver for the resource.
   * @throws {HolqaError} When the binding has not started or the provider supplied no driver.
   */
  const driverOf = <Kind extends DrivenResourceKind>(resource: ResourceDescriptorOf<Kind>): ReturnType<NonNullable<ResourceDrivers[Kind]>> => {
    const { selection, instance } = serving(resource as ResourceDescriptor, `${resource.kind} "${resource.id}"`);
    const factory = instance.drivers?.[resource.kind] as ((resource: ResourceDescriptorOf<Kind>) => ReturnType<NonNullable<ResourceDrivers[Kind]>>) | undefined;
    if (factory === undefined)
      throw new HolqaError(bindingFailure("configuration", { binding: selection.provider.name, message: `Provider "${selection.provider.name}" supplied no ${resource.kind} driver for "${resource.id}".` }));
    return factory(resource);
  };
  const kinds = new Set<ResourceKind>(resolved.resources.map(selection => selection.resource.kind));
  const drivers: ResourceDrivers = Object.freeze({
    ...kinds.has("queue") ? { queue: (resource: ResourceDescriptorOf<"queue">) => driverOf(resource) } : {},
    ...kinds.has("bucket") ? { bucket: (resource: ResourceDescriptorOf<"bucket">) => driverOf(resource) } : {}
  });
  /**
   * Returns the source factory a provider supplied for a resource's kind.
   *
   * @param resource - The resource whose events are delivered.
   * @returns The source factory.
   * @throws {HolqaError} When the binding has not started or the provider supplies no source for the kind.
   */
  const sourceOf = <Kind extends keyof ResourceSources>(resource: ResourceDescriptorOf<Kind>): NonNullable<ResourceSources[Kind]> => {
    const { selection, instance } = serving(resource as ResourceDescriptor, `delivery from ${resource.kind} "${resource.id}"`);
    const factory = instance.sources?.[resource.kind];
    if (factory === undefined)
      throw new HolqaError(bindingFailure("capability", { binding: selection.provider.name, message: `Provider "${selection.provider.name}" delivers no events from the ${resource.kind} "${resource.id}".`, details: { resource: resource.id, kind: resource.kind } }));
    return factory as NonNullable<ResourceSources[Kind]>;
  };
  /**
   * Reports whether any provider selected for a kind delivers events.
   *
   * @param kind - A resource kind with sources.
   * @returns `true` when a source dispatcher is needed for the kind.
   */
  const delivering = (kind: keyof ResourceSources): boolean => resolved.resources.some(selection => selection.resource.kind === kind && (selection.provider.topology?.delivery ?? "none") !== "none");
  const sources: ResourceSources = Object.freeze({
    ...delivering("queue") ? { queue: (resource: ResourceDescriptorOf<"queue">) => sourceOf(resource)(resource) } : {},
    ...delivering("bucket") ? { bucket: (resource: ResourceDescriptorOf<"bucket">) => sourceOf(resource)(resource) } : {},
    ...delivering("schedule") ? { schedule: (resource: ResourceDescriptorOf<"schedule">) => sourceOf(resource)(resource) } : {}
  });

  const serviceProviders = new Map(resolved.services.map(selection => [selection.service, selection.providers]));
  /**
   * Returns the opened instance of a service's single provider.
   *
   * @param service - The single-provider service.
   * @returns The opened instance of the service's provider.
   * @throws {HolqaError} `HOLQA_RUNTIME_NOT_RUNNING` before the binding has started.
   */
  const serviceInstance = (service: "idempotency" | "operation-budgets"): ProviderInstance => {
    const provider = serviceProviders.get(service)?.[0];
    const instance = provider === undefined ? undefined : opened.get(provider);
    if (phase !== "started" || instance === undefined)
      failWith(diagnosticCodes.runtimeNotRunning, `The ${service} service was used while the binding "${resolved.name}" is ${phase}.`);
    return instance;
  };
  const idempotency: IdempotencyStore | undefined = serviceProviders.has("idempotency")
    ? Object.freeze({
      begin: (...args) => serviceInstance("idempotency").idempotency!.begin(...args),
      complete: (...args) => serviceInstance("idempotency").idempotency!.complete(...args),
      release: (...args) => serviceInstance("idempotency").idempotency!.release(...args),
      extend: (...args) => serviceInstance("idempotency").idempotency!.extend(...args)
    } satisfies IdempotencyStore)
    : undefined;
  const operationBudgets: OperationBudgetStore | undefined = serviceProviders.has("operation-budgets")
    ? Object.freeze({ consume: request => serviceInstance("operation-budgets").operationBudgets!.consume(request) } satisfies OperationBudgetStore)
    : undefined;
  const telemetry: readonly TelemetryExporter[] = (serviceProviders.get("telemetry") ?? []).map(provider => forwardingExporter(provider, () => opened.get(provider)?.telemetry ?? []));

  /**
   * Resolves a credential reference through the opened configuration sources.
   *
   * @param provider - The provider asking, for messages.
   * @param reference - The credential reference to resolve.
   * @returns The credential's value.
   * @throws {HolqaError} `HOLQA_BINDING_CREDENTIALS_MISSING` when no source has it.
   */
  const credential = (provider: AnyBindingProvider, reference: CredentialReference): string => {
    // A provider reaches only the credentials it declares, so a binding manifest lists every credential and an extension cannot read another provider's.
    if (!(provider.credentials ?? []).some(declared => declared.name === reference.name))
      throw new HolqaError(bindingFailure("configuration", { binding: provider.name, message: `Provider "${provider.name}" asked for the credential ${reference.name}, which it does not declare.`, hint: "Providers list every credential they use in \"credentials\".", details: { credential: reference.name } }));
    for (const source of configSources) {
      const value = source.lookup(reference.name);
      if (value !== undefined && value !== "") {
        if (value.length >= 4)
          secrets.add(value);
        return value;
      }
    }
    throw new HolqaError(bindingFailure("credentials-missing", { binding: provider.name, message: `The credential ${reference.name} that provider "${provider.name}" needs is not set.`, hint: `Set ${reference.name} through the configuration service (by default, an environment variable).`, details: { credential: reference.name } }));
  };

  /**
   * Opens one provider and records it.
   *
   * @param provider - The provider to open, once.
   * @param options - The start options.
   * @param configPhase - Whether configuration providers are being opened, which cannot use credentials.
   */
  const open = async (provider: AnyBindingProvider, options: BindingStartOptions, configPhase: boolean): Promise<void> => {
    if (opened.has(provider))
      return;
    options.signal.throwIfAborted();
    // Values of declared credentials are known before opening, so an error message that echoes one is redacted.
    if (!configPhase) {
      for (const reference of provider.credentials ?? []) {
        const value = configSources.map(source => source.lookup(reference.name)).find(candidate => candidate !== undefined && candidate.length >= 4);
        if (value !== undefined)
          secrets.add(value);
      }
    }
    const resources = resolved.resources.filter(selection => selection.provider === provider).map(selection => selection.resource);
    let instance: ProviderInstance;
    try {
      instance = await provider.open({
        app,
        environment: resolved.name,
        resources: Object.freeze(resources),
        credential: (reference) => {
          if (configPhase)
            throw new HolqaError(bindingFailure("configuration", { binding: provider.name, message: `Provider "${provider.name}" supplies configuration and cannot itself use the credential reference ${reference.name}.` }));
          return credential(provider, reference);
        },
        signal: options.signal,
        log: (level: BindingLogLevel, message: string, fields?: JsonObject) => log(level, message, { ...fields, provider: provider.name })
      });
    } catch (error) {
      throw new HolqaError(classify(provider, error, secrets), { cause: error });
    }
    opened.set(provider, instance);
    order.push({ provider, instance });
  };

  /**
   * Checks that every opened provider supplied what it was selected for.
   *
   * @returns One `HOLQA_BINDING_CONFIG_INVALID` diagnostic per missing part.
   */
  const missingParts = (): Diagnostic[] => {
    const problems: Diagnostic[] = [];
    /**
     * Records one missing part.
     *
     * @param provider - The provider that lacks it.
     * @param part - What is missing, for the message.
     */
    const report = (provider: AnyBindingProvider, part: string): void => {
      problems.push(bindingFailure("configuration", { binding: provider.name, message: `Provider "${provider.name}" was opened without ${part}, which it declares.` }));
    };
    for (const selection of resolved.resources) {
      const instance = opened.get(selection.provider)!;
      const { kind } = selection.resource;
      if ((kind === "queue" || kind === "bucket") && instance.drivers?.[kind] === undefined)
        report(selection.provider, `a ${kind} driver`);
      if (kind === "schedule" && (selection.provider.topology?.delivery ?? "none") !== "none" && instance.sources?.schedule === undefined)
        report(selection.provider, "a schedule source");
      if (kind === "bucket" && (selection.provider.resources.bucket?.events ?? []).length > 0 && instance.sources?.bucket === undefined)
        report(selection.provider, "an object event source");
    }
    for (const selection of resolved.extensions) {
      if (opened.get(selection.provider)?.extensions?.[selection.id] === undefined)
        report(selection.provider, `an implementation of the extension "${selection.id}"`);
    }
    for (const { service, providers } of resolved.services) {
      for (const provider of providers) {
        const instance = opened.get(provider)!;
        const supplied = service === "config" ? instance.config : service === "telemetry" ? instance.telemetry : service === "idempotency" ? instance.idempotency : instance.operationBudgets;
        if (supplied === undefined)
          report(provider, `the ${service} service`);
      }
    }
    return [...new Map(problems.map(problem => [problem.message, problem])).values()];
  };

  /**
   * Stops every opened provider in reverse order. Failures are logged, never thrown, so one provider cannot keep another open.
   *
   * @param options - The signal that bounds the stop.
   */
  const stopAll = async (options: BindingStopOptions): Promise<void> => {
    for (const { provider, instance } of [...order].reverse()) {
      try {
        await instance.stop?.(options);
      } catch (error) {
        log("warn", "a binding provider failed to stop", { provider: provider.name, error: redact(error instanceof Error ? error.message : String(error), secrets) });
      }
    }
    order.length = 0;
    opened.clear();
  };

  const configProviders = serviceProviders.get("config") ?? [];
  return Object.freeze({
    name: resolved.name,
    capabilities: Object.freeze({}),
    describe: (resource: ResourceDescriptor) => {
      const selection = selections.get(resource.id);
      return selection === undefined
        ? { binding: resolved.name, capabilities: {} }
        : { binding: selection.provider.name, capabilities: selection.provider.resources };
    },
    drivers,
    sources,
    ...idempotency === undefined ? {} : { idempotency },
    ...operationBudgets === undefined ? {} : { operationBudgets },
    ...telemetry.length === 0 ? {} : { telemetry: Object.freeze(telemetry) },
    ...resolved.extensions.length === 0
      ? {}
      : {
        extensions: Object.freeze({
          provided: Object.freeze(Object.fromEntries(resolved.extensions.map(selection => [selection.id, selection.version]))),
          resolve: (id: string) => {
            const selection = resolved.extensions.find(candidate => candidate.id === id);
            const instance = selection === undefined ? undefined : opened.get(selection.provider);
            if (phase !== "started" || instance === undefined)
              failWith(diagnosticCodes.runtimeNotRunning, `The extension "${id}" was used while the binding "${resolved.name}" is ${phase}.`);
            return instance.extensions?.[id];
          }
        })
      },
    config: (entry: ConfigDescriptor) => {
      if (phase !== "started")
        failWith(diagnosticCodes.runtimeNotRunning, `The configuration value ${entry.name} was read while the binding "${resolved.name}" is ${phase}.`);
      return values.get(entry.name);
    },
    lifecycle: Object.freeze({
      start: async (options: BindingStartOptions) => {
        if (phase !== "idle")
          failWith(diagnosticCodes.runtimeStartFailed, `The binding "${resolved.name}" cannot start from the ${phase} state; resolve and create it again.`);
        phase = "starting";
        log = options.log;
        try {
          for (const provider of configProviders)
            await open(provider, options, true);
          configSources = configProviders.map(provider => opened.get(provider)?.config).filter((source): source is ConfigSource => source !== undefined);
          for (const provider of resolved.providers)
            await open(provider, options, false);
          const missing = missingParts();
          if (missing.length > 0)
            throw new HolqaError(missing);
          values = await resolveConfiguration(app.config, (name) => {
            for (const source of configSources) {
              const value = source.lookup(name);
              if (value !== undefined)
                return value;
            }
            return undefined;
          }, { hint: "Supply a value through the configuration service (by default, an environment variable) named" });
          phase = "started";
          log("debug", "binding started", { binding: resolved.name, providers: resolved.providers.map(provider => provider.name) });
        } catch (error) {
          await stopAll({ signal: AbortSignal.timeout(5_000) });
          phase = "stopped";
          throw error;
        }
      },
      ready: async (signal: AbortSignal) => {
        for (const { provider, instance } of order) {
          try {
            await instance.ready?.(signal);
          } catch (error) {
            throw new HolqaError(classify(provider, error, secrets), { cause: error });
          }
        }
      },
      health: async () => {
        if (phase !== "started")
          return combineHealth([{ name: resolved.name, status: "unhealthy", message: `The binding is ${phase}.` }]);
        const components: ComponentHealth[] = [];
        for (const { provider, instance } of order) {
          try {
            components.push(Object.freeze({ ...await instance.health?.() ?? { status: "healthy" as const }, name: provider.name }));
          } catch (error) {
            components.push({ name: provider.name, status: "unhealthy", message: redact(error instanceof Error ? error.message : String(error), secrets) });
          }
        }
        return combineHealth(components);
      },
      stop: async (options: BindingStopOptions) => {
        if (phase === "stopped" || phase === "stopping")
          return;
        phase = "stopping";
        await stopAll(options);
        phase = "stopped";
      }
    })
  } satisfies RuntimeBinding);
}

/**
 * Turns an error from a provider into classified binding failures: Holqa
 * diagnostics pass through, anything else is a permanent failure whose
 * message has every known credential value removed.
 *
 * @param provider - The provider that failed.
 * @param error - What it threw.
 * @param secrets - Credential values resolved so far.
 * @returns The diagnostics to report.
 */
function classify(provider: AnyBindingProvider, error: unknown, secrets: ReadonlySet<string>): readonly Diagnostic[] {
  const diagnostics = diagnosticsOf(error);
  if (diagnostics.length > 0)
    return diagnostics;
  const message = redact(error instanceof Error ? error.message : String(error), secrets);
  return [bindingFailure("failed", { binding: provider.name, message: `Provider "${provider.name}" failed to start: ${message}` })];
}

/**
 * Replaces every occurrence of a known secret value in a text.
 *
 * @param text - The text, for example an error message from a client library.
 * @param secrets - The secret values.
 * @returns The text with each value replaced by `[redacted]`.
 */
function redact(text: string, secrets: ReadonlySet<string>): string {
  let result = text;
  for (const secret of secrets)
    result = result.split(secret).join("[redacted]");
  return result;
}

/**
 * Creates an exporter that forwards to the exporters a telemetry provider
 * supplies once it is opened, so the runtime can be configured with it
 * before the binding starts. Batches recorded before then are dropped.
 *
 * @param provider - The telemetry provider.
 * @param exporters - Returns the provider's exporters (empty until it is opened).
 * @returns The forwarding exporter, named after the provider.
 */
function forwardingExporter(provider: AnyBindingProvider, exporters: () => readonly TelemetryExporter[]): TelemetryExporter {
  return Object.freeze({
    name: provider.name,
    exportSpans: async (...args: Parameters<NonNullable<TelemetryExporter["exportSpans"]>>) => {
      await Promise.all(exporters().map(exporter => exporter.exportSpans?.(...args)));
    },
    exportMetrics: async (...args: Parameters<NonNullable<TelemetryExporter["exportMetrics"]>>) => {
      await Promise.all(exporters().map(exporter => exporter.exportMetrics?.(...args)));
    },
    exportLogs: async (...args: Parameters<NonNullable<TelemetryExporter["exportLogs"]>>) => {
      await Promise.all(exporters().map(exporter => exporter.exportLogs?.(...args)));
    },
    shutdown: async () => {
      await Promise.all(exporters().map(exporter => exporter.shutdown?.()));
    }
  });
}