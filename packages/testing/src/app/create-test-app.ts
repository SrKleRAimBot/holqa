import type {
  JsonValue,
  ObjectMetadata,
  ResourceDescriptor
} from "@holqa/core";
import type {
  LocalEnvironment,
  LocalMessageState,
  LocalObjectEvent,
  LocalQueueMessage,
  LocalScheduleRun,
  ManualClock,
  RedriveOptions
} from "@holqa/local";
import type {
  InvocationOutcome,
  LogEntry,
  LogLevel,
  LogSink,
  Runtime,
  RuntimeDeliveryOptions,
  RuntimeEventLimits,
  RuntimeLimits,
  RuntimeTelemetryOptions
} from "@holqa/runtime-bun";

import type { FailureOptions } from "@/app/faults";
import type { InvocationRecord } from "@/app/invocation-records";
import type {
  ChainStep,
  RecordedInvocation,
  Recording
} from "@/app/recording";
import type { MemoryTelemetry } from "@/telemetry/memory-telemetry";
import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkObjectKey,
  createDiagnostic,
  createRedactor,
  diagnosticCodes,
  failWith,
  getAppDescriptor,
  HolqaError,
  messageEnvelopeFormat,
  prepareWirePayload
} from "@holqa/core";
import { createRuntime } from "@holqa/runtime-bun";

import { FaultPlan } from "@/app/faults";
import { invocationRecords } from "@/app/invocation-records";
import {
  chainSteps,
  createRecording,
  InvocationRecorder,
  readRecordedInvocations
} from "@/app/recording";
import {
  lineageOf,
  SimulationBudget
} from "@/app/simulation-budget";
import { createMemoryTelemetry } from "@/telemetry/memory-telemetry";

/** Settings of {@link createTestApp}. */
export interface TestAppOptions {
  /** The application: the default export of its `infra.ts`. */
  readonly app: unknown;
  /** Handler registrations, as exported by handler modules. */
  readonly handlers: readonly unknown[];
  /** Where each handler is implemented (`<module>#<export>`), logged with failures; `loadCompiledApplication` provides it. */
  readonly handlerSources?: Readonly<Record<string, string>>;
  /** Configuration values. Default `{}`: the test process's environment is never read. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The application root that static sites' directories are relative to. Default: the working directory. */
  readonly root?: string;
  /** Where virtual time starts, as epoch milliseconds or an ISO 8601 string. Default 2026-01-01T00:00:00Z. */
  readonly startTime?: number | string;
  /** Creates invocation, message, event and run identifiers. Default sequential: `id-1`, `id-2`, ... */
  readonly createId?: () => string;
  /** The local state directory. Default a new temporary directory, removed by `dispose`. A given directory is kept. */
  readonly directory?: string;
  /** Runtime limits; see `createRuntime`. */
  readonly limits?: RuntimeLimits;
  /** Delivery settings; see `createRuntime`. */
  readonly delivery?: RuntimeDeliveryOptions;
  /** Event limits (depth, publications, age, per-operation budget); see `createRuntime`. The local binding enforces all of them. */
  readonly events?: RuntimeEventLimits;
  /**
   * The most handler invocations the test application runs. Beyond it every
   * invocation fails before its handler runs, and `flush`, `advance` and
   * `drain` throw `HOLQA_SIMULATION_BUDGET_EXCEEDED` with the busiest
   * handlers and the deepest causal chain, instead of hanging on an event
   * cycle. Default 10 000.
   */
  readonly maxInvocations?: number;
  /** Attempts of queues that declare no `maxAttempts`. Default 5, as in the local environment. */
  readonly defaultMaxAttempts?: number;
  /** Also receives every log entry, for example to print them while debugging a test. */
  readonly log?: LogSink;
  /** The least severe log level recorded. Default `debug`. */
  readonly logLevel?: LogLevel;
  /** Extra field names redacted from logs and telemetry; see `createRuntime`. */
  readonly redact?: { readonly keys?: readonly string[] };
  /**
   * Telemetry settings. Telemetry is always recorded in memory (see
   * {@link TestApp.telemetry}) with deterministic trace and span
   * identifiers; `exporters` adds more, for example an OTLP exporter.
   */
  readonly telemetry?: Omit<RuntimeTelemetryOptions, "enabled" | "ids">;
  /** How long `flush` waits for due work, in real milliseconds. Default 10 000. */
  readonly flushTimeoutMs?: number;
}

/** Settings of {@link TestApp.invoke}. */
export interface TestInvokeOptions {
  /** The delivery attempt a queue consumer or object event handler sees. Default 1. */
  readonly attempt?: number;
  /** The message identifier a queue consumer sees. */
  readonly messageId?: string;
  /** The event identifier an object event handler sees. */
  readonly eventId?: string;
  /** Joins an existing trace. */
  readonly correlationId?: string;
  /** Replaces the generated trusted metadata entirely. */
  readonly metadata?: object;
}

/** Settings of {@link TestApp.drain}. */
export interface DrainOptions {
  /** The most virtual time to move forward, in milliseconds. Default one hour. */
  readonly maxMs?: number;
}

/** Settings of {@link TestApp.recording}. */
export interface RecordingOptions {
  /**
   * Redact fields with sensitive names, the extra `redact.keys` of the test
   * app and the values of declared secrets from inputs and metadata, as logs
   * are redacted. Default `true`: recordings are meant to be stored. Redaction
   * can change what a replay does.
   */
  readonly sanitize?: boolean;
  /** Only invocations of this handler. */
  readonly handlerId?: string;
  /** Only invocations that descend from this root operation. */
  readonly rootId?: string;
}

/** Settings of {@link TestApp.replay}. */
export interface ReplayOptions {
  /**
   * For a whole recording: replay only its root invocations (depth 0) and let
   * the application's code cause the rest again, which is what a regression
   * test usually wants. `false` replays every recorded invocation
   * individually. Default `true`. Ignored for single invocations and lists.
   */
  readonly rootsOnly?: boolean;
  /** Run the work each replayed invocation causes before the next one starts. Default `true`. */
  readonly flush?: boolean;
}

/** Which invocations {@link TestApp.invocations} returns. */
export interface InvocationFilter {
  readonly handlerId?: string;
  readonly correlationId?: string;
  readonly outcome?: "ok" | "failed";
}

/**
 * A running application with isolated local resources and a virtual clock.
 * Queue messages, object events and schedules run through the same runtime
 * and local drivers as `holqa dev`; time only moves when the test moves it.
 */
export interface TestApp {
  /** The virtual clock. Prefer `advance` and `drain`, which also run the work that becomes due. */
  readonly clock: ManualClock;
  readonly runtime: Runtime;
  /** The local environment: queues, storage and scheduler inspection. */
  readonly local: LocalEnvironment;
  /** Every structured log entry written so far, in order. */
  readonly logs: readonly LogEntry[];
  /** The state directory. */
  readonly directory: string;
  /**
   * Serves a request with the application's routes, procedures and local signed URLs.
   * Relative URLs are resolved against `http://holqa.test`.
   */
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /**
   * Invokes a queue consumer, object event handler or schedule handler once,
   * with generated trusted metadata (a first delivery, or a manual run at the
   * virtual time). Nothing is recorded in queue, event or schedule history.
   *
   * @throws {HolqaError} `HOLQA_OPERATION_INVALID` for HTTP handlers; use `fetch`.
   */
  readonly invoke: (handlerId: string, input?: unknown, options?: TestInvokeOptions) => Promise<InvocationOutcome>;
  /**
   * Sends a message to a queue, validated against its schema as a producer's would be.
   *
   * @throws {HolqaError} `HOLQA_RESOURCE_NOT_FOUND`, `HOLQA_INPUT_INVALID`, `HOLQA_PAYLOAD_NOT_SERIALIZABLE` or `HOLQA_OPERATION_INVALID`.
   */
  readonly send: (queueId: string, message: unknown, options?: { readonly delaySeconds?: number }) => Promise<{ readonly messageId: string }>;
  /**
   * Stores an object, which emits `object.created` to subscribed handlers.
   *
   * @throws {HolqaError} `HOLQA_RESOURCE_NOT_FOUND` or `HOLQA_OBJECT_KEY_INVALID`.
   */
  readonly put: (bucketId: string, key: string, body: string | Uint8Array, options?: { readonly contentType?: string }) => Promise<ObjectMetadata>;
  /** Starts a manual run of a schedule through the runtime and its overlap policy; resolves with the run record. */
  readonly trigger: (scheduleId: string) => Promise<LocalScheduleRun>;
  /**
   * Runs every message, event and scheduled run that is due now, including
   * follow-up work they cause, without moving the clock.
   *
   * @throws {HolqaError} `HOLQA_INVOCATION_TIMEOUT` when work is still running after `flushTimeoutMs`.
   */
  readonly flush: () => Promise<void>;
  /**
   * Moves virtual time forward by `ms`, stopping at every timer on the way
   * (delayed messages, retries, schedules) to run the work that became due.
   */
  readonly advance: (ms: number) => Promise<void>;
  /**
   * Moves virtual time forward until no queue message or object event that a
   * handler receives is waiting, for example until every retry has run and
   * failed deliveries are dead-lettered. Schedules that keep firing do not
   * keep it going.
   *
   * @throws {HolqaError} `HOLQA_INVOCATION_TIMEOUT` when work is still waiting after `maxMs` of virtual time.
   */
  readonly drain: (options?: DrainOptions) => Promise<void>;
  /** Makes the next matching invocations of a handler throw, before its own code runs. */
  readonly failNext: (handlerId: string, options?: FailureOptions) => void;
  /** Delivers a known message once more, with the same message identifier. */
  readonly duplicate: (queueId: string, messageId: string) => boolean;
  /** Delivers a known object event once more to one handler. */
  readonly duplicateEvent: (bucketId: string, handlerId: string, eventId: string) => boolean;
  /** Makes dead-lettered messages due again with a fresh attempt count: all, one by message identifier, or a selection. Returns how many. */
  readonly redrive: (queueId: string, selection?: string | RedriveOptions) => number;
  readonly messages: (queueId: string, states?: readonly LocalMessageState[]) => LocalQueueMessage[];
  readonly deadLetters: (queueId: string) => LocalQueueMessage[];
  readonly events: (bucketId: string) => LocalObjectEvent[];
  readonly objects: (bucketId: string, prefix?: string) => ObjectMetadata[];
  /** Reads an object's bytes as text, or `undefined` when it does not exist. */
  readonly read: (bucketId: string, key: string) => Promise<string | undefined>;
  readonly runs: (scheduleId: string, limit?: number) => LocalScheduleRun[];
  /** Finished invocations, read from the logs, in order. */
  readonly invocations: (filter?: InvocationFilter) => InvocationRecord[];
  /** Every finished invocation of one causal chain, in order. */
  readonly trace: (correlationId: string) => InvocationRecord[];
  /** The publication chain that led to an invocation: its causes back to the root operation, root first. */
  readonly lineage: (invocationId: string) => InvocationRecord[];
  /** Every finished invocation that descends from one root operation, the root included, in order. */
  readonly operation: (rootId: string) => InvocationRecord[];
  /**
   * Returns what handlers received so far, as a JSON recording that can be
   * stored and replayed. HTTP requests are recorded but not replayable.
   */
  readonly recording: (options?: RecordingOptions) => Recording;
  /**
   * Replays recorded invocations: each one runs its handler again with the
   * recorded input and trigger metadata through `runtime.invoke`, followed by
   * the work it causes. With the test app's virtual clock and identifiers the
   * replay is deterministic, as far as handler code is: external side effects
   * (network calls, other databases, real time) are reproduced only through
   * explicit mocks or fixtures.
   *
   * @throws {HolqaError} `HOLQA_OPERATION_INVALID` for a malformed recording or an invocation that is not replayable; `HOLQA_HANDLER_NOT_FOUND` comes back as a failed outcome.
   */
  readonly replay: (source: Recording | RecordedInvocation | readonly RecordedInvocation[], options?: ReplayOptions) => Promise<InvocationOutcome[]>;
  /**
   * Steps through one root operation's causal chain: every finished
   * invocation that descends from it, depth first in causal order, each with
   * its recorded input and the step that caused it.
   */
  readonly chain: (rootId: string) => ChainStep[];
  /**
   * Spans, metrics and exported log records, recorded in memory. Call
   * `flushTelemetry` before asserting on them: exports run in the background.
   */
  readonly telemetry: MemoryTelemetry;
  /** Exports everything recorded so far to every exporter and waits for it. */
  readonly flushTelemetry: () => Promise<void>;
  /** Stops the runtime, closes the local state and removes a temporary state directory. Idempotent. */
  readonly dispose: () => Promise<void>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/** The origin relative request URLs and signed URLs use. */
const testOrigin = "http://holqa.test";

/** Default start of virtual time. */
const defaultStart = Date.UTC(2026, 0, 1);

/**
 * Creates and starts an application for an integration test: a runtime on a
 * local environment with its own state directory and a virtual clock, so a
 * test can send messages, upload objects and trigger schedules, move time
 * instead of waiting for retries, inject failures and duplicates, inspect
 * every queue, bucket and schedule, follow traces through the logs, and
 * dispose of everything afterwards.
 *
 * Requires Bun: the local environment stores its state with `bun:sqlite`.
 * Module-level state of the application's own modules is shared by every
 * test app in the process; keep state in resources or `scoped` values.
 *
 * @example
 * ```ts
 * const app = await createTestApp({ app: infra, handlers: [processOrder] });
 * app.failNext("orders.process");
 * await app.send("orders", { orderId: "123" });
 * await app.drain(); // the first attempt fails, the retry after the backoff succeeds
 * expect(app.invocations({ handlerId: "orders.process" }).map(record => record.outcome)).toEqual(["failed", "ok"]);
 * await app.dispose();
 * ```
 *
 * @param options - The application, handlers and test settings.
 * @returns The started test application.
 * @throws {HolqaError} `HOLQA_APP_INVALID`, `HOLQA_DECLARATION_INVALID` for an invalid `startTime` or `maxInvocations`, the errors of `createRuntime`, or `HOLQA_RUNTIME_START_FAILED` with its causes.
 */
export async function createTestApp(options: TestAppOptions): Promise<TestApp> {
  const descriptor = getAppDescriptor(options.app);
  if (descriptor === undefined)
    failWith(diagnosticCodes.appInvalid, "createTestApp was given a value that is not a Holqa application.", "Pass the default export of the application's infra.ts.");
  // Loaded lazily, so that the type assertions of this package import nothing Bun-specific.
  const { createLocalEnvironment, ManualClock, manualTriggerMetadata } = await import("@holqa/local");
  const start = typeof options.startTime === "string" ? Date.parse(options.startTime) : options.startTime ?? defaultStart;
  if (!Number.isFinite(start))
    failWith(diagnosticCodes.declarationInvalid, `"startTime" must be epoch milliseconds or an ISO 8601 time, not ${JSON.stringify(options.startTime)}.`);
  const clock = new ManualClock(start);
  let sequence = 0;
  const createId = options.createId ?? (() => `id-${++sequence}`);
  const temporary = options.directory === undefined;
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "holqa-test-app-"));
  const faults = new FaultPlan();
  const maxInvocations = options.maxInvocations ?? 10_000;
  if (!Number.isSafeInteger(maxInvocations) || maxInvocations < 1)
    failWith(diagnosticCodes.declarationInvalid, `"maxInvocations" must be a positive integer, not ${JSON.stringify(options.maxInvocations)}.`);
  const budget = new SimulationBudget(maxInvocations);
  const recorder = new InvocationRecorder();
  const logs: LogEntry[] = [];
  const memory = createMemoryTelemetry();
  let spanSequence = 0;

  let local: LocalEnvironment | undefined;
  let runtime: Runtime;
  try {
    local = await createLocalEnvironment({
      app: options.app,
      directory,
      env: options.env ?? {},
      ...options.root === undefined ? {} : { root: options.root },
      clock,
      createId,
      // One process owns the state, so receivers never need to poll for work from another process.
      queues: { pollIntervalMs: 86_400_000, ...options.defaultMaxAttempts === undefined ? {} : { defaultMaxAttempts: options.defaultMaxAttempts } },
      storage: { signedUrlBase: `${testOrigin}/_holqa/storage` }
    });
    runtime = createRuntime({
      app: options.app,
      handlers: options.handlers.map(handler => recorder.instrument(budget.instrument(faults.instrument(handler)))),
      ...options.handlerSources === undefined ? {} : { handlerSources: options.handlerSources },
      binding: local.binding,
      ...options.limits === undefined ? {} : { limits: options.limits },
      ...options.delivery === undefined ? {} : { delivery: options.delivery },
      ...options.events === undefined ? {} : { events: options.events },
      log: (entry) => {
        logs.push(entry);
        options.log?.(entry);
      },
      ...options.logLevel === undefined ? {} : { logLevel: options.logLevel },
      ...options.redact === undefined ? {} : { redact: options.redact },
      telemetry: {
        ...options.telemetry,
        enabled: true,
        exporters: [memory.exporter, ...options.telemetry?.exporters ?? []],
        // Deterministic identifiers: the same test produces the same traces.
        ids: { traceId: () => (++spanSequence).toString(16).padStart(32, "0"), spanId: () => (++spanSequence).toString(16).padStart(16, "0") }
      },
      createId,
      clock: () => new Date(clock.now())
    });
    await runtime.start();
  } catch (error) {
    local?.close();
    if (temporary)
      rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const environment = local;

  /**
   * Finds a declared resource of one kind.
   *
   * @param kind - The kind the resource must have.
   * @param resourceId - Its identifier.
   * @returns The descriptor.
   * @throws {HolqaError} `HOLQA_RESOURCE_NOT_FOUND`.
   */
  const resourceOf = <Kind extends ResourceDescriptor["kind"]>(kind: Kind, resourceId: string): ResourceDescriptor & { readonly kind: Kind } => {
    const found = descriptor.resources.find(resource => resource.kind === kind && resource.id === resourceId);
    if (found === undefined)
      failWith(diagnosticCodes.resourceNotFound, `The application "${descriptor.name}" declares no ${kind} "${resourceId}".`);
    return found as ResourceDescriptor & { readonly kind: Kind };
  };

  const flushTimeoutMs = options.flushTimeoutMs ?? 10_000;
  /**
   * Runs the work that is due now.
   *
   * @returns A promise that settles once nothing due is left.
   * @throws {HolqaError} `HOLQA_SIMULATION_BUDGET_EXCEEDED` once the simulation budget ran out, or `HOLQA_INVOCATION_TIMEOUT`.
   */
  const flush = async (): Promise<void> => {
    try {
      await environment.settle({ timeoutMs: flushTimeoutMs });
    } catch (error) {
      // A spent budget explains a timeout better than the timeout does.
      if (budget.exceeded)
        throw budget.failure(invocationRecords(logs));
      throw error;
    }
    if (budget.exceeded)
      throw budget.failure(invocationRecords(logs));
  };

  /**
   * Moves the clock forward, running due work at every timer on the way.
   *
   * @param ms - How far, in milliseconds.
   * @returns A promise that settles once the clock reached the target and the due work ran.
   */
  const advance = async (ms: number): Promise<void> => {
    if (!Number.isFinite(ms) || ms < 0)
      throw new RangeError(`advance needs a finite, non-negative number of milliseconds, not ${String(ms)}.`);
    const target = clock.now() + ms;
    await flush();
    for (;;) {
      const next = clock.nextTimerDue();
      if (next === undefined || next > target)
        break;
      clock.advance(Math.max(0, next - clock.now()));
      await flush();
    }
    clock.advance(target - clock.now());
    await flush();
  };

  /**
   * Returns when the earliest waiting delivery that a handler receives becomes due.
   *
   * @returns Epoch milliseconds, or `undefined` when nothing waits.
   */
  const nextPendingDelivery = (): number | undefined => {
    const times: number[] = [];
    for (const handler of runtime.handlers) {
      const { trigger } = handler;
      if (trigger.kind === "queue.message") {
        for (const message of environment.queues.messages(trigger.resource.id, ["ready", "delayed", "in-flight"]))
          times.push(Date.parse(message.visibleAt));
      } else if (trigger.kind === "bucket.object-created" || trigger.kind === "bucket.object-deleted") {
        for (const event of environment.storage.events(trigger.resource.id)) {
          for (const delivery of event.deliveries) {
            if (delivery.subscription === handler.id && (delivery.state === "ready" || delivery.state === "leased"))
              times.push(Date.parse(delivery.visibleAt));
          }
        }
      }
    }
    return times.length === 0 ? undefined : Math.min(...times);
  };

  let disposing: Promise<void> | undefined;
  /**
   * Stops and removes everything the test app created.
   *
   * @returns A promise that settles once everything is released.
   */
  const dispose = (): Promise<void> => {
    disposing ??= (async () => {
      try {
        await runtime.stop({ graceMs: 1_000, forceMs: 500 });
      } finally {
        environment.close();
        if (temporary)
          rmSync(directory, { recursive: true, force: true });
      }
    })();
    return disposing;
  };

  /**
   * Returns the invocation records that match a filter.
   *
   * @param filter - Which records to return.
   * @returns The records, in log order.
   */
  const invocations = (filter: InvocationFilter = {}): InvocationRecord[] => invocationRecords(logs).filter(record =>
    (filter.handlerId === undefined || record.handlerId === filter.handlerId)
    && (filter.correlationId === undefined || record.correlationId === filter.correlationId)
    && (filter.outcome === undefined || record.outcome === filter.outcome));

  return Object.freeze({
    clock,
    runtime,
    local: environment,
    logs,
    directory,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(new URL(input, testOrigin).href, init);
      return environment.storage.handles(request) ? environment.storage.fetch(request) : runtime.fetch(request);
    },
    invoke: async (handlerId: string, input?: unknown, invokeOptions: TestInvokeOptions = {}) => {
      const definition = runtime.handlers.find(handler => handler.id === handlerId);
      const metadata = invokeOptions.metadata ?? (definition === undefined
        ? undefined
        : manualTriggerMetadata(options.app, definition, {
          now: clock.now(),
          createId,
          ...invokeOptions.attempt === undefined ? {} : { attempt: invokeOptions.attempt },
          ...invokeOptions.messageId === undefined ? {} : { messageId: invokeOptions.messageId },
          ...invokeOptions.eventId === undefined ? {} : { eventId: invokeOptions.eventId }
        }));
      return runtime.invoke({
        handlerId,
        input,
        ...metadata === undefined ? {} : { metadata },
        ...invokeOptions.correlationId === undefined ? {} : { correlationId: invokeOptions.correlationId }
      });
    },
    send: async (queueId: string, message: unknown, sendOptions: { readonly delaySeconds?: number } = {}) => {
      const queue = resourceOf("queue", queueId);
      const delaySeconds = sendOptions.delaySeconds ?? 0;
      if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0)
        failWith(diagnosticCodes.operationInvalid, `"delaySeconds" must be a whole number of at least 0, not ${String(delaySeconds)}.`);
      const subject = `message for queue "${queueId}"`;
      const schema = queue.schemas.message;
      const payload: JsonValue = await prepareWirePayload(schema, message as never, subject);
      const driver = environment.binding.drivers.queue!(queue);
      return driver.send({ format: messageEnvelopeFormat, schemaVersion: queue.config.schemaVersion, payload }, delaySeconds === 0 ? {} : { delaySeconds });
    },
    put: async (bucketId: string, key: string, body: string | Uint8Array, putOptions: { readonly contentType?: string } = {}) => {
      const bucket = resourceOf("bucket", bucketId);
      const problem = checkObjectKey(key, `bucket "${bucketId}" put`);
      if (problem !== undefined)
        throw new HolqaError(problem);
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      return environment.binding.drivers.bucket!(bucket).put(key, bytes, putOptions.contentType === undefined ? {} : { contentType: putOptions.contentType });
    },
    trigger: async (scheduleId: string) => {
      resourceOf("schedule", scheduleId);
      const run = await environment.scheduler.trigger(scheduleId);
      await flush();
      return environment.scheduler.runs(scheduleId).find(candidate => candidate.runId === run.runId) ?? run;
    },
    flush,
    advance,
    drain: async (drainOptions: DrainOptions = {}) => {
      const deadline = clock.now() + (drainOptions.maxMs ?? 3_600_000);
      for (;;) {
        await flush();
        const next = nextPendingDelivery();
        if (next === undefined)
          return;
        if (next > deadline || next <= clock.now()) {
          throw new HolqaError(createDiagnostic({
            code: diagnosticCodes.invocationTimeout,
            severity: "error",
            message: next > deadline
              ? `Deliveries were still waiting after ${drainOptions.maxMs ?? 3_600_000} ms of virtual time; the next is due at ${new Date(next).toISOString()}.`
              : "Deliveries are due, but no handler took them.",
            hint: "Check for handlers that never settle, or pass a larger maxMs."
          }));
        }
        await advance(next - clock.now());
      }
    },
    failNext: (handlerId: string, failureOptions?: FailureOptions) => faults.add(handlerId, failureOptions),
    duplicate: (queueId: string, messageId: string) => environment.queues.duplicate(queueId, messageId),
    duplicateEvent: (bucketId: string, handlerId: string, eventId: string) => environment.storage.duplicateEvent(bucketId, handlerId, eventId),
    redrive: (queueId: string, selection?: string | RedriveOptions) => environment.queues.redrive(queueId, selection),
    messages: (queueId: string, states?: readonly LocalMessageState[]) => environment.queues.messages(queueId, states),
    deadLetters: (queueId: string) => environment.queues.deadLetters(queueId),
    events: (bucketId: string) => environment.storage.events(bucketId),
    objects: (bucketId: string, prefix?: string) => environment.storage.objects(bucketId, prefix),
    read: async (bucketId: string, key: string) => {
      const bytes = await environment.binding.drivers.bucket!(resourceOf("bucket", bucketId)).get(key);
      return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
    },
    runs: (scheduleId: string, limit?: number) => environment.scheduler.runs(scheduleId, limit),
    invocations,
    trace: (correlationId: string) => invocations({ correlationId }),
    lineage: (invocationId: string) => lineageOf(invocationRecords(logs), invocationId),
    operation: (rootId: string) => invocationRecords(logs).filter(record => record.rootId === rootId),
    recording: (recordingOptions: RecordingOptions = {}) => {
      const selected = recorder.invocations().filter(entry =>
        (recordingOptions.handlerId === undefined || entry.handlerId === recordingOptions.handlerId)
        && (recordingOptions.rootId === undefined || entry.lineage.rootId === recordingOptions.rootId));
      const secrets = descriptor.config.filter(entry => entry.sensitive).map(entry => options.env?.[entry.name]).filter((value): value is string => typeof value === "string");
      const redactor = recordingOptions.sanitize === false ? undefined : createRedactor({ ...options.redact?.keys === undefined ? {} : { keys: options.redact.keys }, values: secrets });
      return createRecording(descriptor.name, selected, redactor);
    },
    replay: async (source: Recording | RecordedInvocation | readonly RecordedInvocation[], replayOptions: ReplayOptions = {}) => {
      const { invocations: entries, whole } = readRecordedInvocations(source);
      const selected = whole && replayOptions.rootsOnly !== false ? entries.filter(entry => entry.lineage.depth === 0) : entries;
      const unreplayable = selected.find(entry => !entry.replayable);
      if (unreplayable !== undefined)
        failWith(diagnosticCodes.operationInvalid, `The recorded invocation ${unreplayable.invocationId} of "${unreplayable.handlerId}" (${unreplayable.triggerKind}) has no JSON input and cannot be replayed.`, "Replay HTTP handlers by sending the request again with fetch.");
      const outcomes: InvocationOutcome[] = [];
      for (const entry of selected) {
        outcomes.push(await runtime.invoke({ handlerId: entry.handlerId, ...entry.input === undefined ? {} : { input: entry.input }, metadata: entry.metadata }));
        if (replayOptions.flush !== false)
          await flush();
      }
      return outcomes;
    },
    chain: (rootId: string) => chainSteps(invocationRecords(logs), recorder.invocations(), rootId),
    telemetry: memory,
    flushTelemetry: () => runtime.telemetry.flush(),
    dispose,
    [Symbol.asyncDispose]: dispose
  });
}