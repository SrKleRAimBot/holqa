import type { Result } from "@holqa/core";
import type {
  ExperimentCode,
  JsonObject
} from "@holqa/experiment-model";

import type { RuntimeDiagnostic } from "@/diagnostics";
import type {
  DeadLetter,
  QueueSnapshot
} from "@/drivers/queues";
import type {
  BindingBackend,
  GenerationHost,
  HostOptions,
  LogEntry,
  ReloadStrategy
} from "@/hosts/types";

import {
  err,
  ok
} from "@holqa/core";
import {
  errorCode,
  experimentCodes,
  HolqaError
} from "@holqa/experiment-model";

import {
  holqaError,
  runtimeError
} from "@/diagnostics";
import { Activity } from "@/drivers/activity";
import { InMemoryBuckets } from "@/drivers/buckets";
import { InMemoryQueues } from "@/drivers/queues";
import { createInProcessHost } from "@/hosts/in-process";
import { createWorkerHost } from "@/hosts/worker";
import {
  matchRoute,
  routeTable
} from "@/http";
import { Semaphore } from "@/semaphore";

/** Options accepted by {@link createRuntime}. */
export interface RuntimeOptions {
  /** Absolute path of the application root, the directory that contains the registry file. */
  readonly root: string;
  /** The registry file relative to `root`. Defaults to `infra.ts`. */
  readonly entry?: string;
  /** Raw configuration values, validated against the declared schemas at every load. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How generations are isolated. Defaults to `worker`. */
  readonly strategy?: ReloadStrategy;
  /** How long a replaced generation may finish in-flight work before it is cancelled. Defaults to 5000 ms. */
  readonly drainMs?: number;
  /** Receives handler log entries. */
  readonly onLog?: (entry: LogEntry) => void;
}

/** Options accepted by {@link Runtime.invoke}. */
export interface InvokeOptions {
  /** Aborting it cancels the invocation. */
  readonly signal?: AbortSignal;
  /** Cancels the invocation after this many milliseconds. */
  readonly timeoutMs?: number;
  /** Trigger metadata, such as `attempt` for queue deliveries or `scheduledTime` for schedules. */
  readonly metadata?: JsonObject;
}

/** Options accepted by {@link Runtime.dispose}. */
export interface DisposeOptions {
  /** How long in-flight invocations may finish before they are cancelled. Defaults to 1000 ms. */
  readonly graceMs?: number;
}

/** The lifecycle state of a generation. */
export type GenerationStatus = "active" | "draining" | "disposed";

/** A summary of one generation, for inspection. */
export interface GenerationSummary {
  readonly number: number;
  readonly strategy: ReloadStrategy;
  readonly status: GenerationStatus;
  readonly inFlight: number;
  readonly handlers: readonly string[];
}

/** A point-in-time snapshot of runtime state. */
export interface RuntimeStats {
  readonly status: "running" | "disposing" | "disposed";
  /** The number of the generation that receives new invocations. */
  readonly generation: number | undefined;
  readonly generations: readonly GenerationSummary[];
  /** Running invocations per handler, including orphaned ones. */
  readonly inFlight: Readonly<Record<string, number>>;
  /** Invocations waiting for a concurrency slot, per handler. */
  readonly waiting: Readonly<Record<string, number>>;
  /** The highest concurrency ever observed, per handler. */
  readonly peakConcurrency: Readonly<Record<string, number>>;
  /** Cancelled invocations whose handler code has not finished yet. */
  readonly orphaned: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  /** Queue and storage deliveries in progress. */
  readonly backgroundDeliveries: number;
}

/** Runtime-side state of one generation. */
interface Generation {
  readonly number: number;
  /** Released after disposal so that a disposed generation's module graph can be collected. */
  host: GenerationHost | undefined;
  readonly strategy: ReloadStrategy;
  readonly handlerIds: readonly string[];
  status: GenerationStatus;
  inFlight: number;
  readonly controllers: Set<AbortController>;
  drainWaiters: (() => void)[];
  disposal: Promise<void> | undefined;
}

/**
 * Resolves after a delay, or immediately for non-positive delays.
 *
 * @param ms - The delay in milliseconds.
 * @returns A promise and a function that cancels the timer early.
 */
function delay(ms: number): { readonly promise: Promise<void>; readonly cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Resolves when a signal aborts.
 *
 * @param signal - The signal to watch.
 * @returns A promise of the literal `"aborted"`.
 */
async function whenAborted(signal: AbortSignal): Promise<"aborted"> {
  if (signal.aborted)
    return "aborted";
  return new Promise(resolve => signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
}

/**
 * Converts an abort reason into the error a cancelled caller receives.
 *
 * @param reason - The abort reason.
 * @returns A `HOLQA_INVOCATION_CANCELLED` (or `HOLQA_RUNTIME_DISPOSED`) error.
 */
function cancellation(reason: unknown): HolqaError {
  const code = errorCode(reason);
  if (reason instanceof HolqaError && (code === experimentCodes.invocationCancelled || code === experimentCodes.runtimeDisposed))
    return reason;
  return holqaError(experimentCodes.invocationCancelled, "The invocation was cancelled.");
}

/**
 * A Bun runtime for one application with explicit generations.
 *
 * Invariants it maintains:
 * - New invocations always run on the current generation; a generation is
 *   chosen after the concurrency slot is granted and never changes afterwards.
 * - A reload is fully loaded, validated, configured and bound before it
 *   becomes current; until then, and if it fails, the previous generation serves.
 * - A cancelled invocation settles for its caller immediately, but keeps its
 *   concurrency slot until its handler code actually finishes ("orphaned"),
 *   so cancellation never lets more handlers run than the declared limit.
 * - Queues and buckets belong to the runtime and survive reloads.
 */
export class Runtime {
  private readonly options: Required<Omit<RuntimeOptions, "onLog">> & { readonly onLog: ((entry: LogEntry) => void) | undefined };
  private readonly generations: Generation[] = [];
  private current: Generation | undefined;
  private nextGeneration = 1;
  private nextInvocation = 1;
  private reloadChain: Promise<unknown> = Promise.resolve();
  private readonly retirements = new Set<Promise<void>>();
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly running = new Map<string, number>();
  private readonly lifetime = new AbortController();
  private status: RuntimeStats["status"] = "running";
  private disposal: Promise<void> | undefined;
  private orphaned = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private readonly activity = new Activity();
  private readonly queues: InMemoryQueues;
  private readonly buckets: InMemoryBuckets;
  private readonly backend: BindingBackend;

  /**
   * Creates a runtime. Nothing is loaded until {@link Runtime.load} is called.
   *
   * @param options - Application location, configuration and strategy.
   */
  constructor(options: RuntimeOptions) {
    this.options = {
      root: options.root,
      entry: options.entry ?? "infra.ts",
      env: options.env ?? {},
      strategy: options.strategy ?? "worker",
      drainMs: options.drainMs ?? 5000,
      onLog: options.onLog
    };
    this.queues = new InMemoryQueues({
      consumerFor: queueId => [...this.current?.host?.handlers.values() ?? []].find(handler => handler.trigger.kind === "queue.message" && handler.trigger.resource === queueId)?.id,
      policyFor: (queueId) => {
        const { maxAttempts, deadLetter } = this.current?.host?.resources.get(queueId)?.config ?? {};
        return { maxAttempts: typeof maxAttempts === "number" ? maxAttempts : 3, deadLetter: deadLetter === true };
      },
      deliver: async (handlerId, message, metadata) => this.invoke(handlerId, message, { metadata })
    }, this.activity);
    this.buckets = new InMemoryBuckets({
      objectCreatedHandlers: bucketId => [...this.current?.host?.handlers.values() ?? []]
        .filter(handler => handler.trigger.kind === "bucket.object-created" && handler.trigger.resource === bucketId)
        .map(({ id, trigger: { prefix } }) => ({ id, prefix: typeof prefix === "string" ? prefix : undefined })),
      deliver: async (handlerId, event) => this.invoke(handlerId, event)
    }, this.activity);
    this.backend = {
      queueSend: async (queueId, message) => this.queues.send(queueId, message),
      bucketPut: async (bucketId, key, body, contentType) => this.buckets.put(bucketId, key, body, contentType),
      bucketGet: async (bucketId, key) => this.buckets.get(bucketId, key)
    };
  }

  /**
   * Loads the first generation. Equivalent to {@link Runtime.reload}.
   *
   * @returns The new generation number, or the diagnostics that prevented loading.
   */
  async load(): Promise<Result<number, RuntimeDiagnostic[]>> {
    return this.reload();
  }

  /**
   * Loads the application again as a new generation and swaps it in
   * atomically. Calls are serialized. In-flight invocations finish on their
   * original generation, which is drained and then disposed in the background
   * (see {@link Runtime.retired}).
   *
   * @returns The new generation number, or diagnostics. A failed reload of a
   * running application starts with `HOLQA_RELOAD_FAILED` and leaves the
   * previous generation serving.
   */
  async reload(): Promise<Result<number, RuntimeDiagnostic[]>> {
    const attempt = this.reloadChain.then(async () => this.swap());
    this.reloadChain = attempt.catch(() => undefined);
    return attempt;
  }

  /**
   * Invokes a handler of the current generation.
   *
   * @param handlerId - The handler identifier.
   * @param input - Untrusted input; the handler validates it.
   * @param options - Cancellation signal, timeout and trigger metadata.
   * @returns The handler's result.
   * @throws {HolqaError} `HOLQA_HANDLER_NOT_FOUND`, `HOLQA_RUNTIME_DISPOSED`,
   * `HOLQA_INVOCATION_CANCELLED`, `HOLQA_INPUT_INVALID`, or whatever the handler throws.
   */
  async invoke(handlerId: string, input: unknown, options: InvokeOptions = {}): Promise<unknown> {
    this.assertRunning();
    this.requireHandler(handlerId);
    const controller = new AbortController();
    const unlink = this.link(controller, options);
    try {
      let release: () => void;
      try {
        release = await this.semaphoreFor(handlerId).acquire(controller.signal);
      } catch (reason) {
        this.cancelled += 1;
        throw cancellation(reason);
      }
      let generation: Generation;
      try {
        this.assertRunning();
        generation = this.requireHandler(handlerId);
      } catch (error) {
        release();
        throw error;
      }
      // From here on `run` owns the slot and releases it only when the handler code finishes.
      return await this.run(generation, handlerId, input, options.metadata ?? {}, controller, release);
    } finally {
      unlink();
    }
  }

  /**
   * Serves an HTTP request with the current generation's `http.route` handlers.
   *
   * @param request - A Fetch API request.
   * @returns JSON responses; `400` with diagnostics for invalid input, `404`,
   * `405`, `503` while cancelled or disposed, and a generic `500` that does not
   * leak handler errors.
   */
  async fetch(request: Request): Promise<Response> {
    const host = this.current?.host;
    if (host === undefined || this.status !== "running")
      return Response.json({ diagnostics: [runtimeError(experimentCodes.runtimeDisposed, "The runtime is not serving requests.")] }, { status: 503 });
    const url = new URL(request.url);
    let match;
    try {
      match = matchRoute(routeTable(host.handlers, host.resources), request.method, url.pathname);
    } catch {
      return Response.json({ diagnostics: [runtimeError(experimentCodes.inputInvalid, "The request path is not valid URL encoding.")] }, { status: 400 });
    }
    if (match.kind === "not-found")
      return Response.json({ diagnostics: [runtimeError(experimentCodes.handlerNotFound, `No route matches ${request.method} ${url.pathname}.`)] }, { status: 404 });
    if (match.kind === "method-not-allowed")
      return Response.json({ diagnostics: [runtimeError(experimentCodes.handlerNotFound, `${request.method} is not allowed for ${url.pathname}.`)] }, { status: 405, headers: { allow: match.allowed.join(", ") } });

    const text = await request.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      return Response.json({ diagnostics: [runtimeError(experimentCodes.inputInvalid, "The request body is not valid JSON.")] }, { status: 400 });
    }
    try {
      const result = await this.invoke(match.route.handlerId, {
        params: match.params,
        query: Object.fromEntries(url.searchParams),
        body,
        headers: Object.fromEntries(request.headers)
      }, { signal: request.signal });
      const { status, body: responseBody, headers } = result as { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> };
      return status === 204 ? new Response(null, { status, headers: headers ?? {} }) : Response.json(responseBody, { status, headers: headers ?? {} });
    } catch (error) {
      const code = errorCode(error);
      const statusByCode: Partial<Record<ExperimentCode, number>> = {
        [experimentCodes.inputInvalid]: 400,
        [experimentCodes.handlerNotFound]: 404,
        [experimentCodes.invocationCancelled]: 503,
        [experimentCodes.runtimeDisposed]: 503
      };
      const status = code === undefined ? undefined : statusByCode[code];
      if (status === undefined || !(error instanceof HolqaError))
        return Response.json({ diagnostics: [] }, { status: 500 });
      return Response.json({ diagnostics: [error.diagnostic] }, { status });
    }
  }

  /**
   * Enqueues a message directly, as `holqa queue send` would. The consumer
   * validates it on delivery.
   *
   * @param queueId - The queue identifier.
   * @param message - A JSON-serializable message.
   */
  enqueue(queueId: string, message: unknown): void {
    this.assertRunning();
    this.queues.send(queueId, message);
  }

  /**
   * Stores an object directly, as `holqa storage put` would.
   *
   * @param bucketId - Which bucket to write to.
   * @param key - Where to store the object inside the bucket.
   * @param body - The contents.
   * @param contentType - The MIME type, if known.
   */
  putObject(bucketId: string, key: string, body: string | Uint8Array, contentType?: string): void {
    this.assertRunning();
    this.buckets.put(bucketId, key, body, contentType);
  }

  /**
   * Reads an object from the in-memory store.
   *
   * @param bucketId - Which bucket to read from.
   * @param key - Where the object is stored inside the bucket.
   * @returns The contents, or `undefined` when absent.
   */
  getObject(bucketId: string, key: string): Uint8Array | undefined {
    return this.buckets.get(bucketId, key);
  }

  /**
   * Returns a snapshot of a queue.
   *
   * @param queueId - The queue identifier.
   * @returns Pending, delivered and dropped counts and the dead letters.
   */
  queue(queueId: string): QueueSnapshot {
    return this.queues.snapshot(queueId);
  }

  /**
   * Lists the dead letters of a queue.
   *
   * @param queueId - The queue identifier.
   * @returns The dead-lettered messages, oldest first.
   */
  deadLetters(queueId: string): readonly DeadLetter[] {
    return this.queues.snapshot(queueId).deadLetters;
  }

  /** Failed storage event deliveries. */
  get storageEventFailures(): readonly { readonly handlerId: string; readonly key: string; readonly error: unknown }[] {
    return this.buckets.failures;
  }

  /**
   * Waits until no queue or storage delivery is in progress.
   *
   * @returns Resolves once background work has settled.
   */
  async idle(): Promise<void> {
    await this.activity.idle();
  }

  /**
   * Waits until every replaced generation has been drained and disposed.
   *
   * @returns Resolves once retirements started so far have finished.
   */
  async retired(): Promise<void> {
    await Promise.all(this.retirements);
  }

  /**
   * Returns a snapshot of the runtime's state.
   *
   * @returns Generations, per-handler counters and totals.
   */
  stats(): RuntimeStats {
    /**
     * Reads one counter of every handler's semaphore.
     *
     * @param read - Selects the counter.
     * @returns The counter by handler identifier, sorted.
     */
    const record = (read: (semaphore: Semaphore) => number): Record<string, number> => Object.fromEntries([...this.semaphores].map(([id, semaphore]) => [id, read(semaphore)]).sort(([left], [right]) => String(left).localeCompare(String(right))));
    return {
      status: this.status,
      generation: this.current?.number,
      generations: this.generations.map(generation => ({
        number: generation.number,
        strategy: generation.strategy,
        status: generation.status,
        inFlight: generation.inFlight,
        handlers: generation.handlerIds
      })),
      inFlight: Object.fromEntries([...this.running].sort(([left], [right]) => left.localeCompare(right))),
      waiting: record(semaphore => semaphore.waiting),
      peakConcurrency: record(semaphore => semaphore.peak),
      orphaned: this.orphaned,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      backgroundDeliveries: this.activity.count
    };
  }

  /**
   * Shuts the runtime down: rejects new work immediately, lets in-flight
   * invocations finish for `graceMs`, cancels the rest, and disposes every
   * generation. Idempotent; concurrent calls share one disposal.
   *
   * @param options - The grace period.
   * @returns Resolves when every generation is disposed. Orphaned handler code
   * may still be running with the in-process strategy (see {@link RuntimeStats.orphaned}).
   */
  async dispose(options: DisposeOptions = {}): Promise<void> {
    this.disposal ??= this.shutdown(options.graceMs ?? 1000);
    return this.disposal;
  }

  /**
   * Implements {@link Runtime.dispose}.
   *
   * @param graceMs - How long in-flight work may finish.
   */
  private async shutdown(graceMs: number): Promise<void> {
    this.status = "disposing";
    await this.reloadChain;
    const grace = delay(graceMs);
    await Promise.race([Promise.all(this.generations.map(async generation => this.drained(generation))), grace.promise]);
    grace.cancel();
    this.lifetime.abort(holqaError(experimentCodes.runtimeDisposed, "The runtime was disposed."));
    await Promise.all(this.generations.map(async generation => this.disposeGeneration(generation)));
    await this.retired();
    this.current = undefined;
    this.status = "disposed";
  }

  /**
   * Loads, validates and swaps in a new generation. Runs inside the reload chain.
   *
   * @returns The new generation number, or diagnostics.
   */
  private async swap(): Promise<Result<number, RuntimeDiagnostic[]>> {
    if (this.status !== "running")
      return err([runtimeError(experimentCodes.runtimeDisposed, "The runtime is disposed.")]);
    const number = this.nextGeneration++;
    const hostOptions: HostOptions = {
      root: this.options.root,
      entry: this.options.entry,
      env: this.options.env,
      generation: number,
      backend: this.backend,
      onLog: this.options.onLog ?? (() => {})
    };
    const created = this.options.strategy === "worker" ? await createWorkerHost(hostOptions) : await createInProcessHost(hostOptions);
    if (!created.ok) {
      return err(this.current === undefined
        ? created.error
        : [runtimeError(experimentCodes.reloadFailed, `Reload failed; generation ${String(this.current.number)} keeps serving.`), ...created.error]);
    }
    if (this.status !== "running") {
      await created.value.dispose();
      return err([runtimeError(experimentCodes.runtimeDisposed, "The runtime was disposed during the reload.")]);
    }

    const generation: Generation = {
      number,
      host: created.value,
      strategy: created.value.strategy,
      handlerIds: [...created.value.handlers.keys()].sort(),
      status: "active",
      inFlight: 0,
      controllers: new Set(),
      drainWaiters: [],
      disposal: undefined
    };
    const previous = this.current;
    this.generations.push(generation);
    this.current = generation;
    for (const handler of created.value.handlers.values()) {
      const { concurrency } = handler.config;
      this.semaphoreFor(handler.id).setLimit(typeof concurrency === "number" ? concurrency : Number.POSITIVE_INFINITY);
    }
    if (previous !== undefined) {
      const retirement = this.retire(previous);
      this.retirements.add(retirement);
      void retirement.finally(() => this.retirements.delete(retirement));
    }
    this.queues.pumpAll();
    return ok(number);
  }

  /**
   * Drains a replaced generation for up to `drainMs`, cancels what is left and disposes it.
   *
   * @param generation - The replaced generation.
   */
  private async retire(generation: Generation): Promise<void> {
    generation.status = "draining";
    const timeout = delay(this.options.drainMs);
    await Promise.race([this.drained(generation), timeout.promise]);
    timeout.cancel();
    for (const controller of generation.controllers)
      controller.abort(holqaError(experimentCodes.invocationCancelled, `Generation ${String(generation.number)} was replaced.`));
    await this.disposeGeneration(generation);
  }

  /**
   * Disposes a generation's host once.
   *
   * @param generation - A replaced or final generation.
   * @returns Resolves when the host is disposed.
   */
  private async disposeGeneration(generation: Generation): Promise<void> {
    generation.disposal ??= (generation.host?.dispose() ?? Promise.resolve()).then(() => {
      generation.status = "disposed";
      generation.host = undefined;
    });
    return generation.disposal;
  }

  /**
   * Waits until a generation has no running invocations.
   *
   * @param generation - The generation being drained.
   * @returns Resolves when its in-flight count is zero.
   */
  private async drained(generation: Generation): Promise<void> {
    while (generation.inFlight > 0)
      await new Promise<void>(resolve => generation.drainWaiters.push(resolve));
  }

  /**
   * Runs an invocation that already holds a concurrency slot on its pinned generation.
   *
   * @param generation - The generation the invocation is pinned to.
   * @param handlerId - The handler identifier.
   * @param input - Untrusted input.
   * @param metadata - Trigger metadata.
   * @param controller - The invocation's abort controller.
   * @param release - Releases the concurrency slot; called when the handler code finishes.
   * @returns The handler's result.
   * @throws {HolqaError} `HOLQA_INVOCATION_CANCELLED` when aborted before the handler finishes, or the handler's error.
   */
  private async run(generation: Generation, handlerId: string, input: unknown, metadata: JsonObject, controller: AbortController, release: () => void): Promise<unknown> {
    const host = generation.host;
    if (host === undefined) {
      release();
      throw holqaError(experimentCodes.runtimeDisposed, `Generation ${String(generation.number)} is disposed.`);
    }
    const invocationId = `inv-${String(this.nextInvocation++)}`;
    generation.inFlight += 1;
    generation.controllers.add(controller);
    this.running.set(handlerId, (this.running.get(handlerId) ?? 0) + 1);

    let settled = false;
    let orphan = false;
    const work = host.invoke(handlerId, input, { invocationId, signal: controller.signal, metadata });
    const outcome = work.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    void outcome.then(() => {
      settled = true;
      release();
      generation.inFlight -= 1;
      generation.controllers.delete(controller);
      this.running.set(handlerId, (this.running.get(handlerId) ?? 1) - 1);
      if (orphan)
        this.orphaned -= 1;
      if (generation.inFlight === 0) {
        const waiters = generation.drainWaiters;
        generation.drainWaiters = [];
        for (const wake of waiters)
          wake();
      }
    });

    const first = await Promise.race([outcome, whenAborted(controller.signal)]);
    if (first === "aborted") {
      if (!settled) {
        orphan = true;
        this.orphaned += 1;
      }
      this.cancelled += 1;
      throw cancellation(controller.signal.reason);
    }
    if (first.ok) {
      this.completed += 1;
      return first.value;
    }
    this.failed += 1;
    throw first.error;
  }

  /**
   * Aborts an invocation's controller when the caller's signal aborts, the
   * timeout elapses, or the runtime is disposed.
   *
   * @param controller - The invocation's controller.
   * @param options - The caller's signal and timeout.
   * @returns A function that removes the listeners and timer.
   */
  private link(controller: AbortController, options: InvokeOptions): () => void {
    const cleanups: (() => void)[] = [];
    /**
     * Aborts the controller when a signal aborts.
     *
     * @param signal - The source signal.
     * @param reason - Derives the abort reason from the source signal.
     */
    const follow = (signal: AbortSignal, reason: () => unknown): void => {
      if (signal.aborted) {
        controller.abort(reason());
        return;
      }
      /** Propagates the abort. */
      const onAbort = (): void => {
        controller.abort(reason());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    };
    follow(this.lifetime.signal, () => this.lifetime.signal.reason);
    if (options.signal !== undefined)
      follow(options.signal, () => holqaError(experimentCodes.invocationCancelled, "The caller cancelled the invocation."));
    if (options.timeoutMs !== undefined) {
      const timer = setTimeout(() => controller.abort(holqaError(experimentCodes.invocationCancelled, `The invocation timed out after ${String(options.timeoutMs)} ms.`)), options.timeoutMs);
      cleanups.push(() => clearTimeout(timer));
    }
    return () => {
      for (const cleanup of cleanups)
        cleanup();
    };
  }

  /**
   * Returns the semaphore of a handler, creating an unlimited one on first use.
   *
   * @param handlerId - The handler identifier.
   * @returns The handler's concurrency gate, shared by every generation.
   */
  private semaphoreFor(handlerId: string): Semaphore {
    let semaphore = this.semaphores.get(handlerId);
    if (semaphore === undefined) {
      semaphore = new Semaphore(Number.POSITIVE_INFINITY);
      this.semaphores.set(handlerId, semaphore);
    }
    return semaphore;
  }

  /**
   * Returns the current generation if it registers a handler.
   *
   * @param handlerId - The handler identifier.
   * @returns The current generation.
   * @throws {HolqaError} `HOLQA_HANDLER_NOT_FOUND` when no generation is loaded or the handler is unknown.
   */
  private requireHandler(handlerId: string): Generation {
    const generation = this.current;
    if (generation?.host === undefined || !generation.host.handlers.has(handlerId))
      throw holqaError(experimentCodes.handlerNotFound, `Handler "${handlerId}" is not registered in the current generation.`);
    return generation;
  }

  /**
   * Rejects work once disposal has started.
   *
   * @throws {HolqaError} `HOLQA_RUNTIME_DISPOSED` when the runtime is disposing or disposed.
   */
  private assertRunning(): void {
    if (this.status !== "running")
      throw holqaError(experimentCodes.runtimeDisposed, "The runtime is disposed and accepts no new work.");
  }
}

/**
 * Creates a runtime for an application. Call `load()` before invoking handlers.
 *
 * @param options - Application location, configuration and strategy.
 * @returns A runtime with no generation loaded.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  return new Runtime(options);
}