import type {
  AppDescriptor,
  Diagnostic,
  HandlerDefinition,
  RuntimeBinding
} from "@holqa/core";

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
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf,
  getAppDescriptor,
  getHandlerDescriptor,
  HolqaError
} from "@holqa/core";

import { Dispatcher } from "@/dispatch/dispatcher";
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
   * The data-plane binding for the application's resources and
   * configuration. Defaults to a binding that serves HTTP APIs and reads
   * configuration from `env`; applications with queues, buckets or schedules
   * need a binding that provides them.
   */
  readonly binding?: RuntimeBinding;
  /** Environment variables for the default binding. Defaults to `process.env`. Ignored when `binding` is given. */
  readonly env?: EnvironmentVariables;
  readonly limits?: RuntimeLimits;
  readonly http?: RuntimeHttpOptions;
  /**
   * Accept handlers whose trigger has no transport in this runtime yet
   * (queue consumers, object-created handlers, schedules), so that they can
   * be run with `runtime.invoke` only. Without it, such handlers fail
   * `createRuntime`, because nothing would ever deliver their events.
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
   * Validates configuration, installs the binding and starts accepting
   * invocations. Call it once.
   *
   * @throws {HolqaError} `HOLQA_RUNTIME_START_FAILED` followed by the causes, for example `HOLQA_CONFIG_INVALID` or `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`. The runtime is then `stopped`.
   */
  readonly start: () => Promise<void>;
  /**
   * Stops accepting invocations, lets in-flight ones finish within the grace
   * period, cancels the rest, disposes of application-scoped values and
   * removes the binding. Idempotent: concurrent and repeated calls share one stop.
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
  if (options.manualTriggers !== true) {
    for (const { definition } of handlers.values()) {
      if (definition.trigger.kind !== "http.route" && definition.trigger.kind !== "http.procedure") {
        problems.push(createDiagnostic({
          code: diagnosticCodes.runtimeStartFailed,
          severity: "error",
          message: `The handler "${definition.id}" is triggered by ${definition.trigger.kind}, which this runtime cannot deliver yet.`,
          hint: "Queue, storage and schedule delivery is planned. Pass manualTriggers: true to run such handlers through runtime.invoke only.",
          details: { handler: definition.id, trigger: definition.trigger.kind }
        }));
      }
    }
  }
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
    accepting: () => state === "running"
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
      const binding = options.binding ?? await createEnvironmentBinding(app, options.env ?? process.env);
      if (state !== "starting")
        throw new HolqaError(createDiagnostic({ code: diagnosticCodes.runtimeNotRunning, severity: "error", message: `The runtime for "${app.name}" was stopped while it was starting.` }));
      unbind = bindApp(app, binding);
    } catch (error) {
      state = "stopped";
      const causes = diagnosticsOf(error);
      throw new HolqaError([
        createDiagnostic({ code: diagnosticCodes.runtimeStartFailed, severity: "error", message: `The application "${app.name}" could not start.` }),
        ...causes
      ], { cause: error });
    }
    state = "running";
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
        const drained = await dispatcher.idle(stopOptions.graceMs ?? defaults.graceMs);
        if (!drained) {
          dispatcher.abortAll();
          if (!await dispatcher.idle(stopOptions.forceMs ?? defaults.forceMs))
            logger.write("warn", "handler code was still running when the runtime stopped; it ignored its abort signal", { orphaned: dispatcher.stats().orphaned });
        }
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
    stats: () => Object.freeze({ state, ...dispatcher.stats() })
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
    const concurrency = definition.trigger.kind === "queue.message" ? definition.trigger.options.concurrency : undefined;
    handlers.set(definition.id, {
      definition,
      invoke: descriptor.invoke as RegisteredHandler["invoke"],
      ...concurrency === undefined ? {} : { concurrency: new Semaphore(concurrency) }
    });
  }
  return handlers;
}