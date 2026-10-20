import type {
  AppDescriptor,
  BindingHealth,
  ComponentHealth,
  Diagnostic,
  HandlerDefinition,
  HealthStatus,
  ResourceDescriptorOf,
  RuntimeBinding
} from "@holqa/core";

import type {
  RuntimeDeliveryOptions,
  TransportStats
} from "@/delivery/transports";
import type {
  DispatchStats,
  InvocationOutcome,
  InvocationRequest,
  RegisteredHandler
} from "@/dispatch/dispatcher";
import type { RuntimeEventLimits } from "@/dispatch/event-guard";
import type {
  HandlerRegistryStats,
  HandlerVersionInfo
} from "@/dispatch/handler-registry";
import type { CorsOptions } from "@/http/cors";
import type {
  LogLevel,
  LogSink
} from "@/logging/log";
import type { EnvironmentVariables } from "@/runtime/environment-binding";
import type { TelemetryStats } from "@/telemetry/pipeline";
import type { RuntimeTelemetryOptions } from "@/telemetry/runtime-telemetry";

import {
  bindApp,
  checkExtensions,
  checkTriggerDelivery,
  combineHealth,
  createDiagnostic,
  createRedactor,
  diagnosticCodes,
  diagnosticsOf,
  frameworkMetrics,
  getAppDescriptor,
  getHandlerDescriptor,
  HolqaError,
  queueBackoffProblem,
  resolveDriver
} from "@holqa/core";

import { Transports } from "@/delivery/transports";
import { Dispatcher } from "@/dispatch/dispatcher";
import {
  EventGuard,
  eventLimitProblems
} from "@/dispatch/event-guard";
import { HandlerRegistry } from "@/dispatch/handler-registry";
import { InvocationTracker } from "@/dispatch/invocation-tracker";
import { Semaphore } from "@/dispatch/semaphore";
import { CorsPolicy } from "@/http/cors";
import { createHttpHandler } from "@/http/http-handler";
import { buildRouteTable } from "@/http/router";
import {
  isLogLevel,
  jsonLineSink,
  StructuredLogger
} from "@/logging/log";
import { RuntimeScope } from "@/runtime/application-scope";
import { createEnvironmentBinding } from "@/runtime/environment-binding";
import { checkReplacements } from "@/runtime/handler-replacement";
import { traceBinding } from "@/runtime/traced-binding";
import {
  RuntimeTelemetry,
  telemetryOptionProblems
} from "@/telemetry/runtime-telemetry";

/** Where a runtime is in its lifecycle. */
export type RuntimeState = "idle" | "starting" | "running" | "stopping" | "stopped";

/** Limits on concurrent work and time. */
export interface RuntimeLimits {
  /** Maximum concurrent invocations across all handlers. Default 256. */
  readonly concurrency?: number;
  /** Maximum invocations waiting for a slot; more are rejected with `HOLQA_RUNTIME_OVERLOADED`. Default 1024. */
  readonly queue?: number;
  /** Default time limit of one invocation in milliseconds, including waiting for a slot. Default 30 000. */
  readonly timeoutMs?: number;
  /** How long the binding may take to start and to become ready, in milliseconds, when it has a lifecycle. Default 30 000. */
  readonly bindingStartMs?: number;
}

/** HTTP settings. */
export interface RuntimeHttpOptions {
  /** CORS for browser callers. Absent means no CORS headers. */
  readonly cors?: CorsOptions;
  /**
   * Whether to adopt a caller's `x-correlation-id` header (when it is at most
   * 128 characters of letters, digits, `_`, `.`, `:` and `-`). Default `true`.
   * Set it to `false` when callers are untrusted and logs must not contain
   * caller-chosen identifiers.
   */
  readonly trustCorrelationHeader?: boolean;
}

/** Settings of {@link createRuntime}. */
export interface RuntimeOptions {
  /** The application: the default export of its `infra.ts`. */
  readonly app: unknown;
  /** Handler registrations, as exported by handler modules. */
  readonly handlers: readonly unknown[];
  /**
   * Where each handler is implemented, by handler identifier, as
   * `<module>#<export>` relative to the application root. Logged with failed
   * invocations as `source`. `loadCompiledApplication` provides it.
   */
  readonly handlerSources?: Readonly<Record<string, string>>;
  /**
   * The data-plane binding for the application's resources and
   * configuration. Defaults to a binding that serves HTTP APIs and reads
   * configuration from `env`; applications with queues, buckets or schedules
   * need a binding that provides them.
   */
  readonly binding?: RuntimeBinding;
  /** How queue messages and object events are delivered to handlers. */
  readonly delivery?: RuntimeDeliveryOptions;
  /** Environment variables for the default binding. Defaults to `process.env`. Ignored when `binding` is given. */
  readonly env?: EnvironmentVariables;
  readonly limits?: RuntimeLimits;
  /**
   * Limits on event-driven work: how deep a causal chain may grow, how many
   * events one invocation may publish, how old a delivery may be, and how
   * many events one root operation may publish in total. Events beyond a
   * limit are refused with a terminal outcome instead of being retried.
   */
  readonly events?: RuntimeEventLimits;
  readonly http?: RuntimeHttpOptions;
  /**
   * Run queue consumers, object event handlers and schedule handlers only
   * through `runtime.invoke`: the runtime does not consume the binding's
   * sources. Without it, `start` fails when the binding cannot deliver a
   * handler's trigger, because nothing would ever deliver its events.
   * Default `false`.
   */
  readonly manualTriggers?: boolean;
  /** Where structured logs go. Defaults to JSON lines on standard output. */
  readonly log?: LogSink;
  /** The least severe log level written. Default `debug`: every entry. */
  readonly logLevel?: LogLevel;
  /**
   * Redaction of logs and telemetry. Values of fields whose names contain
   * `password`, `secret`, `token`, `authorization`, `cookie`, `apikey`,
   * `accesskey`, `privatekey`, `credential` or `signature` are always
   * replaced, and so is every occurrence of a declared secret's value (of
   * at least four characters) in any text.
   */
  readonly redact?: {
    /** More field names to redact, matched case-insensitively as substrings, ignoring punctuation. */
    readonly keys?: readonly string[];
  };
  /**
   * Traces, metrics and exported logs. Disabled unless exporters are given
   * or `enabled` is `true`. Telemetry never affects invocations: exports
   * are buffered, bounded and time-limited, and a failing exporter only
   * loses its own data.
   */
  readonly telemetry?: RuntimeTelemetryOptions;
  /** Creates invocation identifiers. Defaults to `crypto.randomUUID`. */
  readonly createId?: () => string;
  /** A monotonic millisecond clock for durations. Defaults to `performance.now`. */
  readonly now?: () => number;
  /** The wall clock used for log timestamps. Defaults to `new Date()`. */
  readonly clock?: () => Date;
}

/** Settings of {@link Runtime.stop}. */
export interface StopOptions {
  /** How long in-flight invocations may finish before they are cancelled, in milliseconds. Default 10 000. */
  readonly graceMs?: number;
  /** How long to wait after cancelling for handler code that ignores its signal, in milliseconds. Default 1 000. */
  readonly forceMs?: number;
  /** How long to wait for the final telemetry export, in milliseconds. Default 5 000. */
  readonly telemetryMs?: number;
  /** How long the binding may take to stop (close connections), in milliseconds, when it has a lifecycle. Default 10 000. */
  readonly bindingMs?: number;
}

/**
 * A runtime's health: whether it accepts work (`state`), and the health of
 * its binding's components. `ready` is `true` while the runtime is running
 * and no component is unhealthy; container platforms use it for readiness,
 * and `state` for liveness.
 */
export interface RuntimeHealth extends BindingHealth {
  readonly state: RuntimeState;
  readonly ready: boolean;
}

/** A snapshot of a runtime's state and counters. */
export interface RuntimeStats extends DispatchStats {
  readonly state: RuntimeState;
  /** Counters of queue, object event and schedule deliveries. */
  readonly delivery: TransportStats;
  /** Counters of recorded, exported and dropped telemetry. */
  readonly telemetry: TelemetryStats;
  /** The handler registry's version and how many replaced implementations are still finishing work. */
  readonly versions: HandlerRegistryStats;
}

/** Settings of {@link Runtime.replaceHandlers}. */
export interface ReplaceHandlersOptions {
  /** Where each replacement is implemented, `<module>#<export>`, by handler identifier; logged with failures. */
  readonly sources?: Readonly<Record<string, string>>;
}

/** The outcome of a successful {@link Runtime.replaceHandlers}. */
export interface HandlerReplacement {
  /** The new registry version, which the replaced handlers' implementations now carry. */
  readonly version: number;
  /** The replaced handlers' identifiers, sorted. */
  readonly handlers: readonly string[];
}

/** Control over a runtime's telemetry. */
export interface RuntimeTelemetryControl {
  /** Whether spans and metrics are recorded. */
  readonly enabled: boolean;
  /** Exports everything recorded so far and waits for the exporters; never rejects. Useful in tests and before a process exits. */
  readonly flush: () => Promise<void>;
}

/**
 * One application execution context: the loaded application, its handlers,
 * its binding and application-scoped values, and the dispatcher that runs
 * every invocation. HTTP requests (`fetch`) and direct invocations
 * (`invoke`) share the same dispatcher, limits and lifecycle.
 */
export interface Runtime {
  readonly state: RuntimeState;
  /** The application's name. */
  readonly name: string;
  /** Every registered handler's definition, sorted by identifier. */
  readonly handlers: readonly HandlerDefinition[];
  /**
   * Validates configuration, installs the binding, starts accepting
   * invocations and, unless `manualTriggers` is set, starts delivering queue
   * messages, object events and scheduled runs from the binding's sources.
   * Call it once.
   *
   * @throws {HolqaError} `HOLQA_RUNTIME_START_FAILED` followed by the causes, for example `HOLQA_CONFIG_INVALID`, `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` or `HOLQA_SCHEDULE_INVALID`. The runtime is then `stopped`.
   */
  readonly start: () => Promise<void>;
  /**
   * Stops receiving deliveries and scheduled runs, stops accepting
   * invocations, lets in-flight ones finish within the grace period, cancels
   * the rest (their deliveries are released for redelivery), disposes of
   * application-scoped values and removes the binding. Idempotent: concurrent
   * and repeated calls share one stop.
   */
  readonly stop: (options?: StopOptions) => Promise<void>;
  /** Runs one invocation of any registered handler as a root of its own lineage (`rootId` and `depth` are ignored); never rejects. */
  readonly invoke: (request: InvocationRequest) => Promise<InvocationOutcome>;
  /** Serves one HTTP request with the application's routes and procedures; never rejects. */
  readonly fetch: (request: Request) => Promise<Response>;
  readonly stats: () => RuntimeStats;
  readonly telemetry: RuntimeTelemetryControl;
  /**
   * Replaces the implementations of registered handlers in place, atomically,
   * as one new registry version: invocations that start afterwards run the
   * new code, while invocations already running finish under the code they
   * started with (or reach their time limit). Triggers, delivery workers,
   * concurrency limits and local state are untouched, so a queue keeps
   * exactly one consumer. A replaced implementation retires once its last
   * invocation finishes: its scope view's signal aborts and scoped values
   * that only it used are disposed of.
   *
   * Intended for development tools such as `holqa dev`. Definitions
   * (trigger, event policy, idempotency, schema roles) must not change; the
   * caller is responsible for checking that schema contents did not change.
   *
   * @throws {HolqaError} `HOLQA_HANDLER_REPLACEMENT_INVALID`, one per problem, and nothing is replaced; `HOLQA_RUNTIME_NOT_RUNNING` once the runtime is stopping.
   */
  readonly replaceHandlers: (handlers: readonly unknown[], options?: ReplaceHandlersOptions) => HandlerReplacement;
  /** Describes every handler's current implementation and the replaced ones still running, sorted by identifier. */
  readonly handlerVersions: () => readonly HandlerVersionInfo[];
  /**
   * Reports the runtime's state and its binding's health: the runtime as one
   * component, followed by the binding's components when the binding has a
   * lifecycle with `health`. Never rejects.
   */
  readonly health: () => Promise<RuntimeHealth>;
}

/** Default limits. */
const defaults = { concurrency: 256, queue: 1024, timeoutMs: 30_000, bindingStartMs: 30_000, graceMs: 10_000, forceMs: 1_000, telemetryMs: 5_000, bindingMs: 10_000 } as const;

/**
 * Creates a runtime for an application and its handlers. Creation is
 * synchronous and side-effect free; it checks that the application and every
 * handler can be served (valid descriptors, unique handler identifiers,
 * triggers that reference declared resources, no route conflicts) and
 * reports every problem at once. Nothing runs until {@link Runtime.start}.
 *
 * @example
 * ```ts
 * const runtime = createRuntime({ app, handlers: [getOrder, placeOrder] });
 * await runtime.start();
 * const response = await runtime.fetch(new Request("http://localhost/api/orders/1"));
 * await runtime.stop();
 * ```
 *
 * @param options - The application, handlers, binding, limits and logging.
 * @returns The runtime, in the `idle` state.
 * @throws {HolqaError} `HOLQA_APP_INVALID`, `HOLQA_DECLARATION_INVALID`, `HOLQA_HANDLER_ID_DUPLICATE`, `HOLQA_RESOURCE_NOT_FOUND`, `HOLQA_TRIGGER_INVALID`, `HOLQA_ROUTE_CONFLICT` or `HOLQA_RUNTIME_START_FAILED` (for invalid options), one diagnostic per problem.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const app = getAppDescriptor(options.app);
  if (app === undefined)
    throw new HolqaError(createDiagnostic({ code: diagnosticCodes.appInvalid, severity: "error", message: "The runtime was given a value that is not a Holqa application.", hint: "Pass the default export of the application's infra.ts, created with defineApp." }));
  const problems: Diagnostic[] = [];
  const limits = readLimits(options.limits, problems);
  const handlers = registerHandlers(app, options.handlers, problems);
  checkDeliveryOptions(options.delivery, problems);
  for (const problem of eventLimitProblems(options.events))
    problems.push(createDiagnostic({ code: diagnosticCodes.runtimeStartFailed, severity: "error", message: problem }));
  problems.push(...telemetryOptionProblems(options.telemetry));
  if (options.logLevel !== undefined && !isLogLevel(options.logLevel))
    problems.push(createDiagnostic({ code: diagnosticCodes.runtimeStartFailed, severity: "error", message: "\"logLevel\" must be \"debug\", \"info\", \"warn\" or \"error\"." }));
  const redactKeys = options.redact?.keys;
  if (redactKeys !== undefined && !(Array.isArray(redactKeys) && redactKeys.every(key => typeof key === "string")))
    problems.push(createDiagnostic({ code: diagnosticCodes.runtimeStartFailed, severity: "error", message: "\"redact.keys\" must be a list of field names." }));
  const { table, problems: routeProblems } = buildRouteTable(app, [...handlers.values()].map(handler => handler.definition));
  problems.push(...routeProblems);
  const siteBases = new Map<string, string>();
  for (const resource of app.resources) {
    if (resource.kind !== "static.site")
      continue;
    const other = siteBases.get(resource.config.basePath);
    if (other !== undefined)
      problems.push(createDiagnostic({ code: diagnosticCodes.routeConflict, severity: "error", message: `The static sites "${other}" and "${resource.id}" are both served under ${resource.config.basePath}.`, hint: "Give each static site its own basePath." }));
    siteBases.set(resource.config.basePath, resource.id);
  }
  let cors: CorsPolicy | undefined;
  try {
    cors = options.http?.cors === undefined ? undefined : new CorsPolicy(options.http.cors);
  } catch (error) {
    problems.push(...diagnosticsOf(error));
  }
  if (problems.length > 0)
    throw new HolqaError(problems);

  const wallClock = options.clock ?? (() => new Date());
  const monotonicNow = options.now ?? (() => performance.now());
  const redactor = createRedactor(redactKeys === undefined ? {} : { keys: redactKeys });
  // Created before the logger, which reports to it; it reports export problems through the logger.
  let logger: StructuredLogger | undefined;
  // Exporters selected by the binding's telemetry service join the runtime's own.
  const bindingExporters = options.binding?.telemetry ?? [];
  const telemetryOptions = bindingExporters.length === 0 ? options.telemetry : { ...options.telemetry, exporters: [...options.telemetry?.exporters ?? [], ...bindingExporters] };
  const telemetry = new RuntimeTelemetry(telemetryOptions, {
    appName: app.name,
    wallNow: () => wallClock().getTime(),
    monotonicNow,
    redactor,
    report: problem => logger?.write("warn", "telemetry export failed; the records were dropped", { code: diagnosticCodes.telemetryExportFailed, exporter: problem.exporter, signal: problem.signal, failures: problem.failures, error: problem.message })
  });
  logger = new StructuredLogger({ sink: options.log ?? jsonLineSink(), clock: wallClock, level: options.logLevel ?? "debug", redactor, onRecord: record => telemetry.log(record) }, { application: app.name });
  const scope = new RuntimeScope(logger);
  const sources = readSources(options.handlerSources);
  const registry = new HandlerRegistry(handlers, {
    open: owner => scope.open(owner),
    release: owner => scope.release(owner),
    retired: (handlerId, version, error) => error === undefined
      ? logger!.write("debug", "handler version retired", { handlerId, handlerVersion: version })
      : logger!.write("error", "releasing a retired handler version failed", { handlerId, handlerVersion: version, error: error instanceof Error ? error.message : String(error) })
  }, sources);
  const tracker = new InvocationTracker();
  const guard = new EventGuard(app, [...handlers.values()].map(handler => handler.definition), options.events);
  let state: RuntimeState = "idle";
  let unbind: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  // The installed binding while its lifecycle is started, so stop can dispose of it.
  let started: RuntimeBinding | undefined;
  const dispatcher = new Dispatcher({
    handlers,
    concurrency: limits.concurrency,
    queueLimit: limits.queue,
    timeoutMs: limits.timeoutMs,
    logger,
    createId: options.createId ?? (() => crypto.randomUUID()),
    now: monotonicNow,
    scope: scope.scope,
    accepting: () => state === "running",
    tracker,
    registry,
    sources,
    telemetry
  });
  telemetry.gauge(frameworkMetrics.activeInvocations, () => {
    const { running, waiting } = dispatcher.stats();
    return [{ value: running, attributes: { "holqa.invocation.state": "running" } }, { value: waiting, attributes: { "holqa.invocation.state": "waiting" } }];
  });
  const transports = new Transports({
    app,
    handlers,
    delivery: options.delivery ?? {},
    timeoutMs: limits.timeoutMs,
    stopping: () => state !== "running",
    logger,
    guard,
    telemetry,
    dispatch: (request, instrumentation) => dispatcher.dispatch(request, instrumentation),
    now: () => wallClock().getTime()
  });
  const sites = app.resources
    .filter((resource): resource is ResourceDescriptorOf<"static.site"> => resource.kind === "static.site")
    .sort((left, right) => right.config.basePath.length - left.config.basePath.length);
  /**
   * Serves a request from the static site whose base path is the longest
   * prefix of the path, through the binding's static site driver.
   *
   * @param request - The request, `GET` or `HEAD`.
   * @param pathname - The request's path.
   * @returns The site's response and route template, or `undefined` when no site answers.
   */
  const serveStatic = async (request: Request, pathname: string): Promise<{ readonly response: Response; readonly route: string } | undefined> => {
    if (state !== "running")
      return undefined;
    for (const site of sites) {
      const base = site.config.basePath;
      if (base !== "/" && pathname !== base && !pathname.startsWith(`${base}/`))
        continue;
      const path = base === "/" ? pathname : pathname.slice(base.length) || "/";
      try {
        const response = await resolveDriver(app, site, `static site "${site.id}"`).fetch(path, request);
        if (response !== undefined)
          return { response, route: `${base === "/" ? "" : base}/*` };
      } catch (error) {
        logger.write("error", "a static site failed to answer", { resourceId: site.id, error: error instanceof Error ? error.message : String(error) });
        return { response: new Response("The file could not be served.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }), route: `${base === "/" ? "" : base}/*` };
      }
    }
    return undefined;
  };
  const fetch = createHttpHandler({ table, dispatcher, logger, ...cors === undefined ? {} : { cors }, trustCorrelationHeader: options.http?.trustCorrelationHeader ?? true, telemetry, now: monotonicNow, ...sites.length === 0 ? {} : { staticSites: serveStatic } });

  /**
   * Stops the started binding's lifecycle once; failures are logged, because the runtime is stopped either way.
   *
   * @param timeoutMs - How long the binding may take.
   */
  const stopBinding = async (timeoutMs: number): Promise<void> => {
    const binding = started;
    started = undefined;
    if (binding?.lifecycle?.stop === undefined)
      return;
    try {
      await binding.lifecycle.stop({ signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      logger.write("warn", "the binding failed to stop cleanly", { binding: binding.name, error: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * Starts the runtime: validates configuration and installs the binding.
   *
   * @throws {HolqaError} `HOLQA_RUNTIME_START_FAILED` and its causes.
   */
  const start = async (): Promise<void> => {
    if (state !== "idle")
      throw new HolqaError(createDiagnostic({ code: diagnosticCodes.runtimeStartFailed, severity: "error", message: `The runtime for "${app.name}" cannot start from the ${state} state; create a new runtime instead.` }));
    state = "starting";
    try {
      // Handler code's sends and writes carry the invocation's trace and are recorded as emitted.
      const binding = traceBinding(options.binding ?? await createEnvironmentBinding(app, options.env ?? process.env), tracker, guard, telemetry);
      if (state !== "starting")
        throw new HolqaError(createDiagnostic({ code: diagnosticCodes.runtimeNotRunning, severity: "error", message: `The runtime for "${app.name}" was stopped while it was starting.` }));
      const unsupported = checkEventSafetySupport(binding, [...handlers.values()].map(handler => handler.definition), guard.needsOperationBudgets);
      if (unsupported.length > 0)
        throw new HolqaError(unsupported);
      guard.attach(binding.operationBudgets);
      if (options.manualTriggers !== true) {
        const undeliverable = checkTriggerDelivery(app, [...handlers.values()].map(handler => handler.definition), binding);
        if (undeliverable.length > 0)
          throw new HolqaError(undeliverable);
      }
      const missingExtensions = checkExtensions(app, binding.extensions?.provided, binding.name).filter(diagnostic => diagnostic.severity === "error");
      if (missingExtensions.length > 0)
        throw new HolqaError(missingExtensions);
      // The binding connects only after every static check passed.
      const lifecycle = binding.lifecycle;
      const startSignal = Number.isFinite(limits.bindingStartMs) ? AbortSignal.timeout(limits.bindingStartMs) : new AbortController().signal;
      // Recorded first, so that a failed or partial start is still stopped.
      started = binding;
      await lifecycle?.start?.({ signal: startSignal, log: (level, message, fields) => logger.write(level, message, fields ?? {}) });
      // Values of declared secrets never reach logs or telemetry.
      redactor.addValues(secretValues(app, binding));
      unbind = bindApp(app, binding);
      telemetry.start();
      state = "running";
      if (options.manualTriggers !== true)
        await transports.start(binding);
      await lifecycle?.ready?.(startSignal);
    } catch (error) {
      state = "stopped";
      unbind?.();
      unbind = undefined;
      await transports.stopReceiving();
      await stopBinding(defaults.bindingMs);
      const causes = diagnosticsOf(error);
      throw new HolqaError([
        createDiagnostic({ code: diagnosticCodes.runtimeStartFailed, severity: "error", message: `The application "${app.name}" could not start.` }),
        ...causes
      ], { cause: error });
    }
    logger.write("info", "runtime started", { handlers: handlers.size });
  };

  /**
   * Stops the runtime gracefully.
   *
   * @param stopOptions - Grace and force periods.
   * @returns A promise that settles once the runtime is stopped.
   */
  const stop = (stopOptions: StopOptions = {}): Promise<void> => {
    stopping ??= (async () => {
      const wasRunning = state === "running";
      state = "stopping";
      if (wasRunning) {
        await transports.stopReceiving();
        const drained = await dispatcher.idle(stopOptions.graceMs ?? defaults.graceMs);
        if (!drained) {
          dispatcher.abortAll();
          if (!await dispatcher.idle(stopOptions.forceMs ?? defaults.forceMs))
            logger.write("warn", "handler code was still running when the runtime stopped; it ignored its abort signal", { orphaned: dispatcher.stats().orphaned });
        }
        // Settle (acknowledge, retry or release) every delivery before the binding goes away.
        await transports.settled();
      }
      // Scoped values stay usable while in-flight invocations drain; releases of retired handler versions finish first.
      await registry.released();
      await scope.dispose();
      unbind?.();
      unbind = undefined;
      state = "stopped";
      if (wasRunning)
        logger.write("info", "runtime stopped", { ...dispatcher.stats() });
      // Telemetry flushes through the binding's exporters before the binding closes them.
      await telemetry.shutdown(stopOptions.telemetryMs ?? defaults.telemetryMs);
      await stopBinding(stopOptions.bindingMs ?? defaults.bindingMs);
    })();
    return stopping;
  };

  return Object.freeze({
    get state() {
      return state;
    },
    name: app.name,
    handlers: Object.freeze([...handlers.values()].map(handler => handler.definition).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    start,
    stop,
    // Lineage is assigned by the runtime: a direct invocation is always a root.
    invoke: ({ rootId: _rootId, depth: _depth, ...request }: InvocationRequest) => dispatcher.dispatch(request),
    fetch,
    stats: () => Object.freeze({ state, ...dispatcher.stats(), delivery: transports.stats(), telemetry: telemetry.stats(), versions: registry.stats() }),
    telemetry: Object.freeze({ enabled: telemetry.enabled, flush: () => telemetry.flush() }),
    replaceHandlers: (replacements: readonly unknown[], replaceOptions: ReplaceHandlersOptions = {}): HandlerReplacement => {
      if (state === "stopping" || state === "stopped")
        throw new HolqaError(createDiagnostic({ code: diagnosticCodes.runtimeNotRunning, severity: "error", message: `The runtime for "${app.name}" is ${state}; its handlers cannot be replaced.` }));
      const { entries, problems: replacementProblems } = checkReplacements(handlers, replacements, replaceOptions.sources);
      if (replacementProblems.length > 0)
        throw new HolqaError(replacementProblems);
      const replacement = registry.replace(entries);
      logger.write("info", "handlers replaced", { handlerVersion: replacement.version, handlers: [...replacement.handlers] });
      return Object.freeze(replacement);
    },
    handlerVersions: () => registry.snapshot(),
    health: async (): Promise<RuntimeHealth> => {
      const runtime: ComponentHealth = { name: "runtime", status: state === "running" ? "healthy" : "unhealthy", ...state === "running" ? {} : { message: `The runtime is ${state}.` } };
      let components: readonly ComponentHealth[] = [];
      const lifecycle = started?.lifecycle;
      if (lifecycle?.health !== undefined) {
        try {
          components = (await lifecycle.health()).components;
        } catch (error) {
          components = [{ name: started?.name ?? "binding", status: "unhealthy", message: error instanceof Error ? error.message : String(error) }];
        }
      }
      const combined = combineHealth([runtime, ...components]);
      const status: HealthStatus = combined.status;
      return Object.freeze({ ...combined, state, ready: state === "running" && status !== "unhealthy" });
    }
  });
}

/**
 * Reads the values of the application's declared secrets from a binding,
 * so that they can be redacted from logs and telemetry. Non-string values
 * contribute their string leaves.
 *
 * @param app - The application.
 * @param binding - The installed binding.
 * @returns The secret strings.
 */
function secretValues(app: AppDescriptor, binding: RuntimeBinding): string[] {
  const values: string[] = [];
  /**
   * Collects the strings of a value.
   *
   * @param value - A configuration value.
   * @param depth - How deep the value is nested.
   */
  const collect = (value: unknown, depth: number): void => {
    if (typeof value === "string")
      values.push(value);
    else if (typeof value === "number" || typeof value === "bigint")
      values.push(String(value));
    else if (typeof value === "object" && value !== null && depth < 8)
      Object.values(value).forEach(item => collect(item, depth + 1));
  };
  for (const entry of app.config) {
    if (entry.sensitive)
      collect(binding.config(entry), 0);
  }
  return values;
}

/**
 * Checks that a binding provides what the runtime's event limits and the
 * handlers' idempotency policies need, so that nothing is enforced partially.
 *
 * @param binding - The binding being installed.
 * @param handlers - The handlers' definitions.
 * @param needsOperationBudgets - Whether a per-operation budget is configured.
 * @returns One `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic per problem.
 */
function checkEventSafetySupport(binding: RuntimeBinding, handlers: readonly HandlerDefinition[], needsOperationBudgets: boolean): Diagnostic[] {
  const problems: Diagnostic[] = [];
  if (needsOperationBudgets && binding.operationBudgets === undefined) {
    problems.push(createDiagnostic({
      code: diagnosticCodes.bindingCapabilityUnsupported,
      severity: "error",
      message: `Binding "${binding.name}" cannot enforce events.maxEventsPerOperation: it provides no atomic operation budget store.`,
      hint: "Use a binding with operation budgets, such as the local binding from @holqa/local, or remove events.maxEventsPerOperation and rely on depth and publication limits."
    }));
  }
  for (const definition of handlers) {
    if (definition.idempotency !== undefined && binding.idempotency === undefined) {
      problems.push(createDiagnostic({
        code: diagnosticCodes.bindingCapabilityUnsupported,
        severity: "error",
        message: `Binding "${binding.name}" provides no idempotency store, which the handler "${definition.id}" declares.`,
        hint: "Use a binding with an idempotency store, such as the local binding from @holqa/local, or remove the handler's idempotency option.",
        details: { handler: definition.id }
      }));
    }
  }
  return problems;
}

/**
 * Validates limits and fills in defaults.
 *
 * @param limits - The configured limits, unvalidated.
 * @param problems - Where to record problems.
 * @returns Complete limits.
 */
function readLimits(limits: RuntimeLimits | undefined, problems: Diagnostic[]): Required<RuntimeLimits> {
  const resolved = { concurrency: limits?.concurrency ?? defaults.concurrency, queue: limits?.queue ?? defaults.queue, timeoutMs: limits?.timeoutMs ?? defaults.timeoutMs, bindingStartMs: limits?.bindingStartMs ?? defaults.bindingStartMs };
  for (const [name, value] of Object.entries(resolved)) {
    const minimum = name === "queue" ? 0 : 1;
    if (!(Number.isSafeInteger(value) && value >= minimum) && value !== Number.POSITIVE_INFINITY)
      problems.push(createDiagnostic({ code: diagnosticCodes.runtimeStartFailed, severity: "error", message: `"limits.${name}" must be an integer of at least ${minimum}.` }));
  }
  return resolved;
}

/**
 * Reads every handler registration and checks it against the application.
 *
 * @param app - The application descriptor.
 * @param registrations - The handler registrations, unvalidated.
 * @param problems - Where to record problems.
 * @returns The handlers by identifier.
 */
function registerHandlers(app: AppDescriptor, registrations: readonly unknown[], problems: Diagnostic[]): Map<string, RegisteredHandler> {
  const handlers = new Map<string, RegisteredHandler>();
  const resources = new Map(app.resources.map(resource => [resource.id, resource]));
  /**
   * Records one problem.
   *
   * @param code - The diagnostic code.
   * @param message - What is wrong.
   */
  const report = (code: Diagnostic["code"], message: string): void => {
    problems.push(createDiagnostic({ code, severity: "error", message }));
  };
  if (!Array.isArray(registrations)) {
    report(diagnosticCodes.declarationInvalid, "\"handlers\" must be a list of handler registrations.");
    return handlers;
  }
  for (const [index, registration] of registrations.entries()) {
    const descriptor = getHandlerDescriptor(registration);
    if (descriptor === undefined) {
      report(diagnosticCodes.declarationInvalid, `handlers[${index}] is not a Holqa handler registration this version can run.`);
      continue;
    }
    const { definition } = descriptor;
    const existing = handlers.get(definition.id);
    if (existing !== undefined) {
      // The same registration listed twice is harmless; two registrations with one identifier are not.
      if (existing.invoke !== descriptor.invoke)
        report(diagnosticCodes.handlerIdDuplicate, `The handler identifier "${definition.id}" is registered more than once.`);
      continue;
    }
    const resource = resources.get(definition.trigger.resource.id);
    if (resource === undefined) {
      report(diagnosticCodes.resourceNotFound, `The handler "${definition.id}" is triggered by "${definition.trigger.resource.id}", which the application "${app.name}" does not declare.`);
      continue;
    }
    if (resource.kind !== definition.trigger.resource.kind) {
      report(diagnosticCodes.triggerInvalid, `The handler "${definition.id}" expects a ${definition.trigger.resource.kind} resource, but "${resource.id}" is a ${resource.kind}.`);
      continue;
    }
    if (definition.trigger.kind === "queue.message") {
      const other = [...handlers.values()].find(handler => handler.definition.trigger.kind === "queue.message" && handler.definition.trigger.resource.id === definition.trigger.resource.id);
      if (other !== undefined) {
        report(diagnosticCodes.queueConsumerDuplicate, `The queue "${definition.trigger.resource.id}" has two consumers, "${other.definition.id}" and "${definition.id}"; a queue has one competing consumer.`);
        continue;
      }
    }
    const concurrency = definition.trigger.kind === "queue.message" ? definition.trigger.options.concurrency : undefined;
    handlers.set(definition.id, {
      definition,
      schemas: descriptor.schemas,
      invoke: descriptor.invoke as RegisteredHandler["invoke"],
      ...concurrency === undefined ? {} : { concurrency: new Semaphore(concurrency) }
    });
  }
  return handlers;
}

/**
 * Reads the optional handler source locations.
 *
 * @param sources - `<module>#<export>` by handler identifier, unvalidated.
 * @returns The string entries; anything else is ignored, because the locations only decorate logs.
 */
function readSources(sources: Readonly<Record<string, string>> | undefined): ReadonlyMap<string, string> {
  if (typeof sources !== "object" || sources === null)
    return new Map();
  return new Map(Object.entries(sources).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/**
 * Validates delivery settings.
 *
 * @param delivery - The configured settings, unvalidated.
 * @param problems - Where to record problems.
 */
function checkDeliveryOptions(delivery: RuntimeDeliveryOptions | undefined, problems: Diagnostic[]): void {
  if (delivery === undefined)
    return;
  /**
   * Records a problem unless a value is absent or a positive safe integer.
   *
   * @param value - The candidate.
   * @param name - The option's name, for the message.
   */
  const positive = (value: unknown, name: string): void => {
    if (value !== undefined && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 1))
      problems.push(createDiagnostic({ code: diagnosticCodes.runtimeStartFailed, severity: "error", message: `"delivery.${name}" must be an integer of at least 1.` }));
  };
  positive(delivery.concurrency, "concurrency");
  positive(delivery.leaseMs, "leaseMs");
  positive(delivery.objectEvents?.maxAttempts, "objectEvents.maxAttempts");
  positive(delivery.objectEvents?.concurrency, "objectEvents.concurrency");
  const backoff = delivery.objectEvents?.backoff;
  const backoffProblem = backoff === undefined ? undefined : queueBackoffProblem(backoff);
  if (backoffProblem !== undefined)
    problems.push(createDiagnostic({ code: diagnosticCodes.runtimeStartFailed, severity: "error", message: `"delivery.objectEvents.backoff" is invalid: ${backoffProblem}.` }));
  const deadLetter = delivery.objectEvents?.deadLetter;
  if (deadLetter !== undefined && typeof deadLetter !== "boolean")
    problems.push(createDiagnostic({ code: diagnosticCodes.runtimeStartFailed, severity: "error", message: "\"delivery.objectEvents.deadLetter\" must be a boolean." }));
}