import type {
  ApplicationScope,
  HandlerDefinition,
  HandlerDescriptor,
  InvocationContext,
  InvocationLineage,
  JsonObject
} from "@holqa/core";

import type { EventGuardViolation } from "@/dispatch/event-guard";
import type { InvocationFailure } from "@/dispatch/failure";
import type {
  ActiveInvocation,
  EmittedEvent,
  InvocationTracker
} from "@/dispatch/invocation-tracker";
import type { StructuredLogger } from "@/logging/log";

import { diagnosticCodes } from "@holqa/core";

import {
  failureFromError,
  InvocationAbort,
  runtimeFailure
} from "@/dispatch/failure";
import {
  Semaphore,
  SemaphoreFullError
} from "@/dispatch/semaphore";
import { describeError } from "@/logging/log";

/** The longest delay a timer can represent (2^31 - 1 ms); longer ones would fire at once. */
const maxTimerDelay = 2_147_483_647;

/** A handler the dispatcher can run: its metadata and its executable `invoke`. */
export interface RegisteredHandler {
  readonly definition: HandlerDefinition;
  /** The schemas the handler validates its input with, by role. */
  readonly schemas: HandlerDescriptor["schemas"];
  readonly invoke: (input: unknown, context: InvocationContext<never>) => Promise<unknown>;
  /** The handler's own concurrency limit, for triggers that declare one (queue consumers). */
  readonly concurrency?: Semaphore;
}

/**
 * One normalized invocation: which handler to run, its untrusted input and
 * trusted metadata, and how the caller controls it.
 */
export interface InvocationRequest {
  /** The stable identifier of the handler to run. */
  readonly handlerId: string;
  /** Untrusted input; the handler validates it. */
  readonly input?: unknown;
  /** Trusted trigger metadata, such as a queue delivery attempt. */
  readonly metadata?: object;
  /** Aborting it cancels the invocation: the caller gets `HOLQA_INVOCATION_CANCELLED` at once. */
  readonly signal?: AbortSignal;
  /** Groups related invocations in logs; defaults to the invocation identifier. */
  readonly correlationId?: string;
  /** The invocation that caused this one, for example the one that sent the message being delivered. Logged as `causationId`. */
  readonly causationId?: string;
  /**
   * The root operation the invocation descends from, for event lineage and
   * per-operation budgets. Only delivery transports set it; `runtime.invoke`
   * ignores it. Absent means the invocation is a root and its own identifier is the root.
   */
  readonly rootId?: string;
  /** How many event hops separate the invocation from its root; 0 (the default) for a root. */
  readonly depth?: number;
  /** Overrides the runtime's default time limit for this invocation. */
  readonly timeoutMs?: number;
  /** Extra fields for this invocation's log entries, such as the HTTP method and path. */
  readonly logFields?: JsonObject;
}

/** What every outcome reports. */
interface OutcomeBase {
  readonly invocationId: string;
  readonly correlationId: string;
  readonly handlerId: string;
  /** Milliseconds from dispatch to outcome, including time spent waiting for a slot. */
  readonly durationMs: number;
  /** Messages the handler sent and objects it changed before the outcome, in order. Empty when the handler did not run. */
  readonly emitted: readonly EmittedEvent[];
  /** The invocation's event lineage. */
  readonly lineage: InvocationLineage;
  /**
   * Set when an event guard refused something the handler tried to publish.
   * A failed invocation with a refusal ends its delivery terminally (it is
   * not retried), even when the handler wrapped or replaced the guard's error.
   */
  readonly blocked?: EventGuardViolation;
}

/** A successful invocation and the value its handler resolved to. */
export interface InvocationSuccess extends OutcomeBase {
  readonly ok: true;
  readonly value: unknown;
}

/** A failed invocation with its normalized failure. */
export interface InvocationFailed extends OutcomeBase {
  readonly ok: false;
  readonly failure: InvocationFailure;
}

/** The structured result of one invocation, discriminated by `ok`. */
export type InvocationOutcome = InvocationSuccess | InvocationFailed;

/** Counters describing a dispatcher's work. */
export interface DispatchStats {
  /** Handler executions still running, including orphans. */
  readonly running: number;
  /** Invocations waiting for a concurrency slot. */
  readonly waiting: number;
  /** Executions whose caller already received a timeout or cancellation but whose code is still running. They keep their slot. */
  readonly orphaned: number;
  readonly succeeded: number;
  readonly failed: number;
  /** The highest number of executions that ran at once. */
  readonly peakConcurrency: number;
}

/** Settings of a {@link Dispatcher}. */
export interface DispatcherOptions {
  readonly handlers: ReadonlyMap<string, RegisteredHandler>;
  /** Maximum concurrent executions across all handlers. */
  readonly concurrency: number;
  /** Maximum invocations waiting for a slot before new ones are rejected with `HOLQA_RUNTIME_OVERLOADED`. */
  readonly queueLimit: number;
  /** Default time limit of an invocation, in milliseconds, including waiting for a slot. */
  readonly timeoutMs: number;
  readonly logger: StructuredLogger;
  /** Creates unique invocation identifiers. */
  readonly createId: () => string;
  /** A monotonic clock in milliseconds, for durations. */
  readonly now: () => number;
  /** The application execution context passed to every invocation. */
  readonly scope: ApplicationScope;
  /** Whether new invocations are accepted, checked at dispatch. */
  readonly accepting: () => boolean;
  /** Attributes resource operations to the invocation that performs them. */
  readonly tracker: InvocationTracker;
  /** Where each handler is implemented (`module#export`), by handler identifier; logged with failures. */
  readonly sources: ReadonlyMap<string, string>;
}

/**
 * The common invocation engine. Every trigger (HTTP routes, RPC procedures,
 * queue deliveries, object events and scheduled runs) goes through `dispatch`, so
 * invocation identity, cancellation, time limits, concurrency limits, error
 * normalization and logging behave the same for all of them. Transports only
 * differ in how they build the request and present the outcome.
 */
export class Dispatcher {
  /** Settings. */
  private readonly options: DispatcherOptions;
  /** The environment-wide concurrency gate. */
  private readonly gate: Semaphore;
  /** Abort functions of invocations whose caller is still waiting. */
  private readonly live = new Set<(cause: "shutdown") => void>();
  /** Resolvers waiting for every execution to finish. */
  private idleWaiters: Array<() => void> = [];
  /** Running executions, including orphans. */
  private running = 0;
  /** Executions whose caller has given up. */
  private orphaned = 0;
  /** Invocations that succeeded. */
  private succeeded = 0;
  /** Invocations that failed. */
  private failed = 0;

  /**
   * Creates a dispatcher.
   *
   * @param options - Handlers, limits, logging and the application scope.
   */
  constructor(options: DispatcherOptions) {
    this.options = options;
    this.gate = new Semaphore(options.concurrency, options.queueLimit);
  }

  /**
   * Runs one invocation to a structured outcome. Never rejects: every
   * failure, including an unknown handler, a full queue, a timeout or a
   * thrown error, becomes an `ok: false` outcome.
   *
   * The invocation's signal is aborted when the caller's signal aborts, when
   * its time limit passes, or when the runtime stops. The caller then gets
   * its outcome at once; a handler that ignores the signal keeps running as
   * an orphan and keeps its concurrency slot until it finishes, because
   * JavaScript cannot stop it.
   *
   * @param request - The invocation to run.
   * @returns The outcome.
   */
  async dispatch(request: InvocationRequest): Promise<InvocationOutcome> {
    const { options } = this;
    const invocationId = options.createId();
    const correlationId = request.correlationId ?? invocationId;
    const depth = typeof request.depth === "number" && Number.isSafeInteger(request.depth) && request.depth >= 0 ? request.depth : 0;
    const rootId = typeof request.rootId === "string" && request.rootId !== "" ? request.rootId : invocationId;
    const lineage: InvocationLineage = Object.freeze({ correlationId, ...request.causationId === undefined ? {} : { causationId: request.causationId }, rootId, depth });
    const started = options.now();
    const handler = options.handlers.get(request.handlerId);
    const trigger = handler?.definition.trigger;
    const log = options.logger.child({
      handlerId: request.handlerId,
      invocationId,
      correlationId,
      ...request.causationId === undefined ? {} : { causationId: request.causationId },
      // A root invocation is its own root at depth 0; only descendants log their lineage.
      ...rootId === invocationId && depth === 0 ? {} : { rootId, depth },
      ...trigger === undefined ? {} : { triggerKind: trigger.kind, resourceId: trigger.resource.id },
      ...request.logFields
    });
    const base = { invocationId, correlationId, handlerId: request.handlerId, lineage };
    const source = options.sources.get(request.handlerId);

    /**
     * Records and logs a finished invocation.
     *
     * @param outcome - The value on success, or the failure.
     * @param outcome.value - The handler's result.
     * @param outcome.failure - The normalized failure.
     * @param emitted - What the handler emitted before the outcome.
     * @param blocked - What an event guard refused, if anything.
     * @returns The outcome.
     */
    const finish = (outcome: { readonly value: unknown } | { readonly failure: InvocationFailure }, emitted: readonly EmittedEvent[] = [], blocked?: EventGuardViolation): InvocationOutcome => {
      const durationMs = options.now() - started;
      const effects = Object.freeze([...emitted]);
      const emittedField: JsonObject = effects.length === 0 ? {} : { emitted: effects.map(event => ({ ...event })) };
      const blockedField: JsonObject = blocked === undefined ? {} : { blocked: blocked.code };
      const refusal = blocked === undefined ? {} : { blocked };
      if ("failure" in outcome) {
        this.failed += 1;
        const { failure } = outcome;
        const fields: JsonObject = { outcome: "failed", code: failure.code, durationMs, ...emittedField, ...blockedField, ...source === undefined ? {} : { source }, ...failure.error === undefined ? {} : { error: describeError(failure.error) } };
        log.write(failure.status >= 500 ? "error" : "info", "invocation failed", fields);
        return Object.freeze({ ...base, ok: false, failure, durationMs, emitted: effects, ...refusal });
      }
      this.succeeded += 1;
      log.write("info", "invocation completed", { outcome: "ok", durationMs, ...emittedField, ...blockedField });
      return Object.freeze({ ...base, ok: true, value: outcome.value, durationMs, emitted: effects, ...refusal });
    };

    if (!options.accepting())
      return finish({ failure: runtimeFailure(diagnosticCodes.runtimeNotRunning, "The runtime is not accepting invocations.") });
    if (handler === undefined)
      return finish({ failure: runtimeFailure(diagnosticCodes.handlerNotFound, `No handler with the identifier "${request.handlerId}" is registered.`) });
    const limit = request.timeoutMs ?? options.timeoutMs;
    if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0)
      return finish({ failure: runtimeFailure(diagnosticCodes.inputInvalid, "\"timeoutMs\" must be a positive number of milliseconds, or Infinity.", {}, 400) });
    const metadataProblem = checkMetadata(handler.definition, request.metadata);
    if (metadataProblem !== undefined)
      return finish({ failure: runtimeFailure(diagnosticCodes.inputInvalid, metadataProblem, {}, 400) });

    const controller = new AbortController();
    /**
     * Aborts the invocation once, with a reason that records why.
     *
     * @param cause - Why it is aborted.
     */
    const abort = (cause: "timeout" | "cancelled" | "shutdown"): void => {
      if (!controller.signal.aborted)
        controller.abort(new InvocationAbort(cause));
    };
    /**
     * Cancels the invocation when the caller's signal aborts.
     *
     * @returns Nothing; the invocation's signal is aborted.
     */
    const onCallerAbort = (): void => abort("cancelled");
    if (request.signal?.aborted === true)
      abort("cancelled");
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });
    // `Infinity` means no limit; timers cannot represent longer delays than 2^31 - 1 ms.
    const timer = Number.isFinite(limit) ? setTimeout(abort, Math.min(limit, maxTimerDelay), "timeout") : undefined;
    this.live.add(abort);
    const releases: Array<() => void> = [];
    try {
      try {
        // The handler's own gate first, so invocations queued behind a
        // low-concurrency handler never hold environment-wide slots.
        if (handler.concurrency !== undefined)
          releases.push(await handler.concurrency.acquire(controller.signal));
        releases.push(await this.gate.acquire(controller.signal));
      } catch (error) {
        for (const release of releases)
          release();
        if (error instanceof SemaphoreFullError)
          return finish({ failure: runtimeFailure(diagnosticCodes.runtimeOverloaded, "The runtime is at its concurrency limit; try again later.", { "retry-after": "1" }) });
        return finish({ failure: failureFromError(error) });
      }
      if (controller.signal.aborted) {
        // Aborted while the slot was being granted: never start the handler.
        for (const release of releases)
          release();
        return finish({ failure: failureFromError(controller.signal.reason) });
      }
      return await this.execute(handler, request, controller.signal, releases, log, finish, {
        invocationId,
        correlationId,
        lineage,
        signal: controller.signal,
        metadata: (request.metadata ?? {}) as never,
        log: log.forHandler(),
        scope: options.scope
      });
    } finally {
      clearTimeout(timer);
      this.live.delete(abort);
      request.signal?.removeEventListener("abort", onCallerAbort);
      this.notifyIfIdle();
    }
  }

  /**
   * Runs the handler and races it against the invocation's signal.
   *
   * @param handler - The handler to run.
   * @param request - The invocation request.
   * @param signal - The invocation's signal.
   * @param releases - Releases the concurrency slots; called when the handler's code finishes.
   * @param log - The invocation's logger.
   * @param finish - Records the outcome.
   * @param context - The invocation context passed to the handler.
   * @returns The outcome.
   */
  private async execute(handler: RegisteredHandler, request: InvocationRequest, signal: AbortSignal, releases: ReadonlyArray<() => void>, log: StructuredLogger, finish: (outcome: { readonly value: unknown } | { readonly failure: InvocationFailure }, emitted: readonly EmittedEvent[], blocked?: EventGuardViolation) => InvocationOutcome, context: InvocationContext<never> & { readonly lineage: InvocationLineage }): Promise<InvocationOutcome> {
    this.running += 1;
    let settled = false;
    let orphan = false;
    const started = this.options.now();
    const active: ActiveInvocation = { invocationId: context.invocationId, correlationId: context.correlationId ?? context.invocationId, handlerId: handler.definition.id, lineage: context.lineage, publications: 0, emitted: [] };
    // A handler that throws synchronously becomes a rejected execution, like an async one.
    // Running it inside the tracker attributes its resource operations to this invocation.
    const execution = Promise.resolve().then(() => this.options.tracker.run(active, () => handler.invoke(request.input, context)));
    /** Releases the slots once the handler's code has finished, whether or not its caller is still waiting. */
    const onSettled = (): void => {
      settled = true;
      for (const release of releases)
        release();
      this.running -= 1;
      if (orphan) {
        this.orphaned -= 1;
        log.write("warn", "an aborted invocation finished after its caller stopped waiting", { durationMs: this.options.now() - started });
      }
      this.notifyIfIdle();
    };
    execution.then(onSettled, onSettled);

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<{ readonly reason: unknown }>((resolve) => {
      onAbort = () => resolve({ reason: signal.reason });
      if (signal.aborted)
        onAbort();
      else
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const winner = await Promise.race([execution.then(value => ({ value })), aborted]);
      if ("reason" in winner) {
        if (!settled) {
          orphan = true;
          this.orphaned += 1;
        }
        return finish({ failure: failureFromError(winner.reason) }, active.emitted, active.blocked);
      }
      return finish({ value: winner.value }, active.emitted, active.blocked);
    } catch (error) {
      return finish({ failure: failureFromError(error) }, active.emitted, active.blocked);
    } finally {
      signal.removeEventListener("abort", onAbort!);
    }
  }

  /**
   * Aborts every invocation whose caller is still waiting, for example when
   * the runtime's shutdown grace period ends. Their callers receive
   * `HOLQA_INVOCATION_CANCELLED`.
   */
  abortAll(): void {
    for (const abort of [...this.live])
      abort("shutdown");
  }

  /**
   * Waits until no invocation is admitted (running, or waiting for a slot)
   * and no handler code is running, including orphans.
   *
   * @param timeoutMs - The longest time to wait.
   * @returns `true` when the dispatcher became idle, `false` when the time ran out first.
   */
  async idle(timeoutMs: number): Promise<boolean> {
    if (this.isIdle())
      return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const becameIdle = new Promise<boolean>((resolve) => {
      this.idleWaiters.push(() => resolve(true));
    });
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(resolve, timeoutMs, false);
    });
    try {
      return await Promise.race([becameIdle, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Returns counters describing the dispatcher's work.
   *
   * @returns A snapshot of the counters.
   */
  stats(): DispatchStats {
    return Object.freeze({
      running: this.running,
      waiting: this.gate.waiting,
      orphaned: this.orphaned,
      succeeded: this.succeeded,
      failed: this.failed,
      peakConcurrency: this.gate.peak
    });
  }

  /**
   * Reports whether nothing is admitted or running.
   *
   * @returns `true` when no caller is waiting and no handler code runs.
   */
  private isIdle(): boolean {
    return this.running === 0 && this.live.size === 0;
  }

  /** Resolves everyone waiting in {@link idle} once nothing is admitted or running. */
  private notifyIfIdle(): void {
    if (!this.isIdle())
      return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters)
      resolve();
  }
}

/**
 * Checks that trusted metadata passed to a direct invocation has the shape
 * the handler's trigger kind promises its handler.
 *
 * @param definition - The handler's definition.
 * @param metadata - The metadata the caller passed.
 * @returns A description of the problem, or `undefined` when the metadata fits.
 */
function checkMetadata(definition: HandlerDefinition, metadata: object | undefined): string | undefined {
  const fields = (metadata ?? {}) as Readonly<Record<string, unknown>>;
  const { attempt, messageId, schemaVersion, scheduledTime, runId, trigger, eventId, eventTime } = fields;
  const isAttempt = typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 1;
  const { kind } = definition.trigger;
  if (kind === "queue.message" && (!isAttempt || typeof messageId !== "string" || (schemaVersion !== undefined && (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1))))
    return `Invoking the queue consumer "${definition.id}" requires metadata { attempt: positive integer, messageId: string, schemaVersion?: positive integer }.`;
  if ((kind === "bucket.object-created" || kind === "bucket.object-deleted") && (!isAttempt || typeof eventId !== "string" || typeof eventTime !== "string"))
    return `Invoking the object event handler "${definition.id}" requires metadata { eventId: string, eventTime: ISO 8601 string, attempt: positive integer }.`;
  if (kind === "schedule.tick" && (typeof scheduledTime !== "string" || (runId !== undefined && typeof runId !== "string") || (trigger !== undefined && trigger !== "cron" && trigger !== "manual")))
    return `Invoking the schedule handler "${definition.id}" requires metadata { scheduledTime: ISO 8601 string, runId?: string, trigger?: "cron" | "manual" }.`;
  return undefined;
}