import type {
  AppDescriptor,
  Diagnostic,
  HandlerDefinition,
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
import type { CorsOptions } from "@/http/cors";
import type { LogSink } from "@/logging/log";
import type { EnvironmentVariables } from "@/runtime/environment-binding";

import {
  bindApp,
  checkTriggerDelivery,
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf,
  getAppDescriptor,
  getHandlerDescriptor,
  HolqaError,
  queueBackoffProblem
} from "@holqa/core";

import { Transports } from "@/delivery/transports";
import { Dispatcher } from "@/dispatch/dispatcher";
import { InvocationTracker } from "@/dispatch/invocation-tracker";
import { Semaphore } from "@/dispatch/semaphore";
import { CorsPolicy } from "@/http/cors";
import { createHttpHandler } from "@/http/http-handler";
import { buildRouteTable } from "@/http/router";
import {
  jsonLineSink,
  StructuredLogger
} from "@/logging/log";
import { RuntimeScope } from "@/runtime/application-scope";
import { createEnvironmentBinding } from "@/runtime/environment-binding";
import { traceBinding } from "@/runtime/traced-binding";

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
}

/** A snapshot of a runtime's state and counters. */
export interface RuntimeStats extends DispatchStats {
  readonly state: RuntimeState;
  /** Counters of queue, object event and schedule deliveries. */
  readonly delivery: TransportStats;
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
  /** Runs one invocation of any registered handler; never rejects. */
  readonly invoke: (request: InvocationRequest) => Promise<InvocationOutcome>;
  /** Serves one HTTP request with the application's routes and procedures; never rejects. */
  readonly fetch: (request: Request) => Promise<Response>;
  readonly stats: () => RuntimeStats;
}

/** Default limits. */
const defaults = { concurrency: 256, queue: 1024, timeoutMs: 30_000, graceMs: 10_000, forceMs: 1_000 } as const;

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
  const { table, problems: routeProblems } = buildRouteTable(app, [...handlers.values()].map(handler => handler.definition));
  problems.push(...routeProblems);
  let cors: CorsPolicy | undefined;
  try {
    cors = options.http?.cors === undefined ? undefined : new CorsPolicy(options.http.cors);
  } catch (error) {
    problems.push(...diagnosticsOf(error));
  }
  if (problems.length > 0)
    throw new HolqaError(problems);

  const logger = new StructuredLogger(options.log ?? jsonLineSink(), { application: app.name }, options.clock);
  const scope = new RuntimeScope(logger);
  const tracker = new InvocationTracker();
  let state: RuntimeState = "idle";
  let unbind: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  const dispatcher = new Dispatcher({
    handlers,
    concurrency: limits.concurrency,
    queueLimit: limits.queue,
    timeoutMs: limits.timeoutMs,
    logger,
    createId: options.createId ?? (() => crypto.randomUUID()),
    now: options.now ?? (() => performance.now()),
    scope: scope.scope,
    accepting: () => state === "running",
    tracker,
    sources: readSources(options.handlerSources)
  });
  const transports = new Transports({
    app,
    handlers,
    delivery: options.delivery ?? {},
    timeoutMs: limits.timeoutMs,
    dispatch: request => dispatcher.dispatch(request),
    stopping: () => state !== "running",
    logger
  });
  const fetch = createHttpHandler({ table, dispatcher, logger, ...cors === undefined ? {} : { cors }, trustCorrelationHeader: options.http?.trustCorrelationHeader ?? true });

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
      const binding = traceBinding(options.binding ?? await createEnvironmentBinding(app, options.env ?? process.env), tracker);
      if (state !== "starting")
        throw new HolqaError(createDiagnostic({ code: diagnosticCodes.runtimeNotRunning, severity: "error", message: `The runtime for "${app.name}" was stopped while it was starting.` }));
      if (options.manualTriggers !== true) {
        const undeliverable = checkTriggerDelivery(app, [...handlers.values()].map(handler => handler.definition), binding);
        if (undeliverable.length > 0)
          throw new HolqaError(undeliverable);
      }
      unbind = bindApp(app, binding);
      state = "running";
      if (options.manualTriggers !== true)
        await transports.start(binding);
    } catch (error) {
      state = "stopped";
      unbind?.();
      unbind = undefined;
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
      // Scoped values stay usable while in-flight invocations drain.
      await scope.dispose();
      unbind?.();
      unbind = undefined;
      state = "stopped";
      if (wasRunning)
        logger.write("info", "runtime stopped", { ...dispatcher.stats() });
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
    invoke: (request: InvocationRequest) => dispatcher.dispatch(request),
    fetch,
    stats: () => Object.freeze({ state, ...dispatcher.stats(), delivery: transports.stats() })
  });
}

/**
 * Validates limits and fills in defaults.
 *
 * @param limits - The configured limits, unvalidated.
 * @param problems - Where to record problems.
 * @returns Complete limits.
 */
function readLimits(limits: RuntimeLimits | undefined, problems: Diagnostic[]): Required<RuntimeLimits> {
  const resolved = { concurrency: limits?.concurrency ?? defaults.concurrency, queue: limits?.queue ?? defaults.queue, timeoutMs: limits?.timeoutMs ?? defaults.timeoutMs };
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