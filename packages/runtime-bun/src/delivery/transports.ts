import type {
  AppDescriptor,
  DeliverySource,
  JsonValue,
  LeasedDelivery,
  MessageEnvelope,
  ObjectEvent,
  ObjectEventSource,
  ObjectEventType,
  QueueBackoff,
  QueueSource,
  ResourceDescriptor,
  RuntimeBinding,
  ScheduleRunResult,
  ScheduleSubscription,
  ScheduleTick,
  SpanLink,
  StandardSchemaV1,
  TelemetryAttributes,
  TraceContext
} from "@holqa/core";

import type {
  DeliveryPolicy,
  DeliveryStats,
  PreparedDelivery
} from "@/delivery/delivery-worker";
import type {
  InvocationInstrumentation,
  InvocationOutcome,
  InvocationRequest,
  RegisteredHandler
} from "@/dispatch/dispatcher";
import type { EventGuard } from "@/dispatch/event-guard";
import type { StructuredLogger } from "@/logging/log";
import type { RuntimeTelemetry } from "@/telemetry/runtime-telemetry";

import {
  defaultQueueBackoff,
  diagnosticCodes,
  frameworkMetrics,
  InputValidationError,
  lineageOfDelivery,
  messageEnvelopeFormat,
  parseTraceparent,
  readObjectEvent,
  validateInput
} from "@holqa/core";

import {
  DeliveryWorker,
  sumDeliveryStats
} from "@/delivery/delivery-worker";
import { describeError } from "@/logging/log";

/** Delivery settings shared by queue consumers and object event handlers. */
export interface RuntimeDeliveryOptions {
  /** In-flight deliveries per queue consumer that declares no `concurrency`. Default 4. */
  readonly concurrency?: number;
  /**
   * How long a received delivery stays leased, in milliseconds. A handler
   * still running when its lease expires may run again concurrently, so the
   * lease must outlast the invocation time limit. Default: the runtime's
   * `limits.timeoutMs` plus 5 000.
   */
  readonly leaseMs?: number;
  /** How object event handlers treat failures, which buckets do not declare. Default: 3 attempts, the default backoff, dead-lettered. */
  readonly objectEvents?: {
    readonly maxAttempts?: number;
    readonly backoff?: QueueBackoff;
    readonly deadLetter?: boolean;
    /** In-flight events per handler. Default 4. */
    readonly concurrency?: number;
  };
}

/** Counters of every delivery the runtime handled, by trigger family. */
export interface TransportStats {
  readonly queues: DeliveryStats;
  readonly objectEvents: DeliveryStats;
  readonly schedules: {
    readonly started: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly skipped: number;
  };
}

/** Settings of {@link Transports}. */
export interface TransportsOptions {
  readonly app: AppDescriptor;
  readonly handlers: ReadonlyMap<string, RegisteredHandler>;
  readonly delivery: RuntimeDeliveryOptions;
  /** The runtime's default invocation time limit. */
  readonly timeoutMs: number;
  readonly dispatch: (request: InvocationRequest, instrumentation?: InvocationInstrumentation) => Promise<InvocationOutcome>;
  readonly stopping: () => boolean;
  readonly logger: StructuredLogger;
  /** Applies depth and age limits to every delivery. */
  readonly guard: EventGuard;
  /** Records processing spans and delivery metrics. */
  readonly telemetry: RuntimeTelemetry;
  /** The wall clock, in epoch milliseconds, for event age. */
  readonly now: () => number;
}

/** Event types by object trigger kind. */
const objectEventTypeOf = { "bucket.object-created": "object.created", "bucket.object-deleted": "object.deleted" } as const satisfies Record<string, ObjectEventType>;

/**
 * The background transports of one runtime: a delivery worker per queue
 * consumer and per object event handler, and a subscription per schedule
 * handler. Every invocation goes through the runtime's dispatcher, so limits,
 * cancellation, error normalization and logs are the same as for HTTP.
 */
export class Transports {
  /** Settings. */
  private readonly options: TransportsOptions;
  /** Queue consumer workers. */
  private readonly queueWorkers: Array<DeliveryWorker<MessageEnvelope>> = [];
  /** Object event workers. */
  private readonly eventWorkers: Array<DeliveryWorker<ObjectEvent>> = [];
  /** Schedule subscriptions. */
  private readonly subscriptions: ScheduleSubscription[] = [];
  /** Runs in progress by schedule identifier. */
  private readonly running = new Map<string, number>();
  /** Schedule runs in progress. */
  private readonly runs = new Set<Promise<unknown>>();
  /** Schedule counters. */
  private readonly scheduleCounts = { started: 0, succeeded: 0, failed: 0, skipped: 0 };

  /**
   * Creates the transports; nothing is delivered until {@link start}.
   *
   * @param options - The application, handlers, settings and dispatcher.
   */
  constructor(options: TransportsOptions) {
    this.options = options;
  }

  /**
   * Subscribes to every source and starts the workers. On failure, whatever
   * was already started is stopped again before the error propagates.
   *
   * @param binding - The installed binding; `checkTriggerDelivery` must have found no problem.
   * @returns A promise that settles once every transport runs.
   * @throws {unknown} Whatever a source throws while subscribing, for example `HOLQA_SCHEDULE_INVALID`.
   */
  async start(binding: RuntimeBinding): Promise<void> {
    const sources = binding.sources ?? {};
    const resources = new Map<string, ResourceDescriptor>(this.options.app.resources.map(resource => [resource.id, resource]));
    const bucketSources = new Map<string, ObjectEventSource>();
    const queueSources = new Map<string, QueueSource>();
    try {
      for (const handler of this.options.handlers.values()) {
        const { definition } = handler;
        const resource = resources.get(definition.trigger.resource.id);
        if (resource === undefined)
          continue;
        if (definition.trigger.kind === "queue.message" && resource.kind === "queue" && sources.queue !== undefined) {
          const source = sources.queue(resource);
          queueSources.set(resource.id, source);
          this.queueWorkers.push(this.queueWorker(handler, resource, source));
        } else if ((definition.trigger.kind === "bucket.object-created" || definition.trigger.kind === "bucket.object-deleted") && resource.kind === "bucket" && sources.bucket !== undefined) {
          let source = bucketSources.get(resource.id);
          if (source === undefined) {
            source = sources.bucket(resource);
            bucketSources.set(resource.id, source);
          }
          const type = objectEventTypeOf[definition.trigger.kind];
          const prefix = definition.trigger.options.prefix;
          const subscription = await source.subscribe({ id: definition.id, types: [type], ...prefix === undefined ? {} : { prefix } });
          this.eventWorkers.push(this.eventWorker(handler, type, prefix, subscription));
        } else if (definition.trigger.kind === "schedule.tick" && resource.kind === "schedule" && sources.schedule !== undefined) {
          const overlap = resource.requirements.overlap;
          this.subscriptions.push(await sources.schedule(resource).start(tick => this.runSchedule(handler, resource.id, overlap, tick)));
        }
      }
    } catch (error) {
      await this.stopReceiving();
      throw error;
    }
    this.observeBacklog(queueSources);
    for (const worker of [...this.queueWorkers, ...this.eventWorkers])
      worker.start();
  }

  /**
   * Reports each consumed queue's backlog as the `holqa.queue.pending`
   * gauge, for the queues whose source can count it.
   *
   * @param sources - The consumed queues' sources, by queue identifier.
   */
  private observeBacklog(sources: ReadonlyMap<string, QueueSource>): void {
    const countable = [...sources].filter(([, source]) => source.pending !== undefined);
    if (countable.length === 0)
      return;
    this.options.telemetry.gauge(frameworkMetrics.queuePending, async () => Promise.all(countable.map(async ([queueId, source]) => ({ value: await source.pending!(), attributes: { "messaging.destination.name": queueId } }))));
  }

  /**
   * Stops receiving deliveries and scheduled runs. Work already started continues.
   *
   * @returns A promise that settles once nothing new will be started.
   */
  async stopReceiving(): Promise<void> {
    const results = await Promise.allSettled([
      ...this.subscriptions.map(subscription => subscription.stop()),
      ...[...this.queueWorkers, ...this.eventWorkers].map(worker => worker.stopReceiving())
    ]);
    for (const result of results) {
      if (result.status === "rejected")
        this.options.logger.write("error", "a transport failed to stop cleanly", { error: describeError(result.reason) });
    }
  }

  /**
   * Waits until every delivery and run in flight has been settled.
   *
   * @returns A promise that settles when nothing is pending.
   */
  async settled(): Promise<void> {
    await Promise.all([...this.queueWorkers, ...this.eventWorkers].map(worker => worker.settled()));
    while (this.runs.size > 0)
      await Promise.allSettled([...this.runs]);
  }

  /**
   * Returns the counters of every transport.
   *
   * @returns A snapshot.
   */
  stats(): TransportStats {
    return Object.freeze({
      queues: sumDeliveryStats(this.queueWorkers.map(worker => worker.stats())),
      objectEvents: sumDeliveryStats(this.eventWorkers.map(worker => worker.stats())),
      schedules: Object.freeze({ ...this.scheduleCounts })
    });
  }

  /**
   * Creates the worker of one queue consumer. Envelopes with another schema
   * version and payloads that fail the message schema are rejected without a
   * retry, because no redelivery can make them valid.
   *
   * @param handler - The consumer.
   * @param resource - The queue descriptor, with its delivery requirements and schema version.
   * @param source - The queue's deliveries.
   * @returns A worker that is not started yet.
   */
  private queueWorker(handler: RegisteredHandler, resource: ResourceDescriptor & { readonly kind: "queue" }, source: QueueSource): DeliveryWorker<MessageEnvelope> {
    const { requirements, config } = resource;
    const schema = (handler.schemas as { readonly message?: StandardSchemaV1 }).message;
    const options = handler.definition.trigger.kind === "queue.message" ? handler.definition.trigger.options : {};
    const subject = `message for queue "${resource.id}"`;
    return this.worker(handler, source, {
      maxAttempts: requirements.maxAttempts ?? source.defaultMaxAttempts,
      backoff: requirements.backoff ?? defaultQueueBackoff,
      deadLetter: requirements.deadLetter
    }, options.concurrency ?? this.options.delivery.concurrency ?? 4, async (delivery) => {
      const envelope: unknown = delivery.body;
      if (typeof envelope !== "object" || envelope === null || (envelope as { readonly format?: unknown }).format !== messageEnvelopeFormat || !("payload" in envelope))
        return { kind: "reject", code: diagnosticCodes.payloadMalformed, message: `The delivery of ${subject} is not a ${messageEnvelopeFormat} envelope.` };
      const { schemaVersion, payload } = envelope as { readonly schemaVersion?: unknown; readonly payload: JsonValue };
      if (typeof schemaVersion !== "number" || schemaVersion < config.schemaVersion)
        return { kind: "reject", code: diagnosticCodes.payloadVersionUnsupported, message: `The ${subject} has schema version ${String(schemaVersion)}; the consumer accepts ${config.schemaVersion}.` };
      // A newer version usually means producers were deployed before this consumer: retry, so an updated consumer can take it.
      if (schemaVersion > config.schemaVersion)
        return { kind: "fail", code: diagnosticCodes.payloadVersionUnsupported, message: `The ${subject} has schema version ${schemaVersion}, newer than the consumer's ${config.schemaVersion}.` };
      if (schema !== undefined) {
        try {
          await validateInput(schema, payload, subject);
        } catch (error) {
          if (error instanceof InputValidationError)
            return { kind: "reject", code: diagnosticCodes.inputInvalid, message: `The ${subject} does not match its schema.` };
          throw error;
        }
      }
      return { kind: "invoke", input: payload, metadata: { attempt: delivery.attempt, messageId: delivery.id, schemaVersion: config.schemaVersion } };
    });
  }

  /**
   * Creates the worker of one object event handler.
   *
   * @param handler - The object event handler every delivery invokes.
   * @param type - The event type it handles.
   * @param prefix - Its key prefix filter.
   * @param source - The subscription's deliveries.
   * @returns A worker that is not started yet.
   */
  private eventWorker(handler: RegisteredHandler, type: ObjectEventType, prefix: string | undefined, source: DeliverySource<ObjectEvent>): DeliveryWorker<ObjectEvent> {
    const settings = this.options.delivery.objectEvents ?? {};
    return this.worker(handler, source, {
      maxAttempts: settings.maxAttempts ?? 3,
      backoff: settings.backoff ?? defaultQueueBackoff,
      deadLetter: settings.deadLetter ?? true
    }, settings.concurrency ?? 4, async (delivery) => {
      const event = readObjectEvent(delivery.body, `object event for handler "${handler.definition.id}"`);
      // Sources filter by subscription; checking again keeps a misbehaving source from invoking the wrong handler.
      if (event.type !== type || (prefix !== undefined && !event.object.key.startsWith(prefix)))
        return { kind: "skip", reason: "the event does not match the handler's subscription" };
      const { key, size, contentType } = event.object;
      const input = type === "object.created" ? { key, size, ...contentType === undefined ? {} : { contentType } } : { key };
      return { kind: "invoke", input, metadata: { eventId: event.id, eventTime: event.time, attempt: delivery.attempt } };
    });
  }

  /**
   * Creates a worker with the runtime's shared settings.
   *
   * @param handler - The handler every delivery invokes.
   * @param source - The deliveries.
   * @param policy - How failures are treated.
   * @param concurrency - In-flight deliveries.
   * @param prepare - Turns a delivery into an invocation.
   * @returns A worker that is not started yet.
   */
  private worker<Body>(handler: RegisteredHandler, source: DeliverySource<Body>, policy: DeliveryPolicy, concurrency: number, prepare: (delivery: LeasedDelivery<Body>) => Promise<PreparedDelivery>): DeliveryWorker<Body> {
    const { timeoutMs, delivery, dispatch, stopping, logger, guard, now, telemetry } = this.options;
    const handlerId = handler.definition.id;
    const destination = handler.definition.trigger.resource.id;
    const objectEvent = handler.definition.trigger.kind !== "queue.message";
    return new DeliveryWorker<Body>({
      handlerId,
      source,
      policy,
      concurrency,
      leaseMs: delivery.leaseMs ?? (Number.isFinite(timeoutMs) ? timeoutMs + 5_000 : 300_000),
      timeoutMs,
      prepare,
      dispatch,
      stopping,
      logger: logger.child({ transport: handler.definition.trigger.kind }),
      telemetry,
      destination,
      instrument: received => this.instrumentation(destination, received.trace?.traceparent, {
        "messaging.system": "holqa",
        "messaging.destination.name": destination,
        "messaging.operation.type": "process",
        "messaging.operation.name": "process",
        "holqa.delivery.attempt": received.attempt,
        ...objectEvent ? { "holqa.object_event.id": received.id } : { "messaging.message.id": received.id }
      }),
      admit: received => guard.checkDelivery(handlerId, lineageOfDelivery(received.trace, received.id), received.sentAt, now())
    });
  }

  /**
   * Describes the processing span of one delivery: a consumer span named
   * `process <destination>` that is a child of the publishing span (or, with
   * `telemetry.messages: "link"`, the root of a new trace) and links to it.
   *
   * @param destination - The queue or bucket.
   * @param traceparent - The publishing span's context, when the binding stored it.
   * @param attributes - The span's attributes.
   * @returns The instrumentation for the dispatcher.
   */
  private instrumentation(destination: string, traceparent: string | undefined, attributes: TelemetryAttributes): InvocationInstrumentation {
    const publisher: TraceContext | undefined = parseTraceparent(traceparent);
    const links: SpanLink[] = publisher === undefined ? [] : [{ traceId: publisher.traceId, spanId: publisher.spanId }];
    const parent = publisher !== undefined && this.options.telemetry.messages === "parent" ? publisher : undefined;
    return { name: `process ${destination}`, kind: "consumer", attributes, links, ...parent === undefined ? {} : { parent } };
  }

  /**
   * Runs one scheduled run, applying the schedule's overlap policy.
   *
   * @param handler - The handler the schedule runs.
   * @param scheduleId - Identifies the schedule whose runs are counted for overlap.
   * @param overlap - What happens when a run is due while another is in progress.
   * @param tick - The due run.
   * @returns The run's result, reported back to the scheduler.
   */
  private async runSchedule(handler: RegisteredHandler, scheduleId: string, overlap: "skip" | "allow", tick: ScheduleTick): Promise<ScheduleRunResult> {
    const inProgress = this.running.get(scheduleId) ?? 0;
    const log = this.options.logger.child({ transport: "schedule.tick", handlerId: handler.definition.id, runId: tick.runId, scheduledTime: tick.scheduledTime });
    if (overlap === "skip" && inProgress > 0) {
      this.scheduleCounts.skipped += 1;
      log.write("info", "scheduled run skipped; the previous run is still in progress");
      return { status: "skipped", code: diagnosticCodes.scheduleRunSkipped, message: "The previous run was still in progress." };
    }
    this.running.set(scheduleId, inProgress + 1);
    this.scheduleCounts.started += 1;
    const run = this.options.dispatch({
      handlerId: handler.definition.id,
      metadata: { scheduledTime: tick.scheduledTime, runId: tick.runId, trigger: tick.trigger },
      correlationId: tick.runId,
      timeoutMs: this.options.timeoutMs,
      logFields: { runId: tick.runId, trigger: tick.trigger }
    }, { name: `run ${scheduleId}`, kind: "internal", attributes: { "holqa.schedule.run_id": tick.runId, "holqa.schedule.trigger": tick.trigger, "holqa.schedule.scheduled_time": tick.scheduledTime } });
    this.runs.add(run);
    try {
      const outcome = await run;
      if (outcome.ok) {
        this.scheduleCounts.succeeded += 1;
        return { status: "succeeded", invocationId: outcome.invocationId };
      }
      this.scheduleCounts.failed += 1;
      return { status: "failed", code: outcome.failure.code, message: outcome.failure.message, invocationId: outcome.invocationId };
    } finally {
      this.runs.delete(run);
      this.running.set(scheduleId, (this.running.get(scheduleId) ?? 1) - 1);
    }
  }
}