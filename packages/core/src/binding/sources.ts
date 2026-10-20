import type { DeliveryTrace } from "@/binding/trace";
import type { ScheduleRunTrigger } from "@/handlers/triggers";
import type { JsonObject } from "@/json";
import type { ObjectEventType } from "@/resources/kinds";
import type { ResourceDescriptorOf } from "@/resources/resource-descriptor";
import type { ObjectEvent } from "@/storage/object-event";
import type { MessageEnvelope } from "@/wire/message-envelope";

// Sources are the consuming half of a binding. Drivers (`ResourceDrivers`)
// let handler code *use* resources; sources let a runtime *deliver* their
// events to handlers. The split keeps delivery policy in one place: a source
// only stores and leases deliveries, and the runtime decides when to retry,
// how long to back off and when to dead-letter, so every binding applies a
// queue's declared policy the same way.

/**
 * One leased delivery. While the lease lasts, no other receiver gets the same
 * delivery; when it expires without settlement, the delivery becomes
 * available again with a higher `attempt`. That is what makes delivery at
 * least once rather than exactly once.
 *
 * @typeParam Body - What is delivered: a message envelope or an object event.
 */
export interface LeasedDelivery<Body> {
  /** Opaque handle that settles this delivery. Valid only for this lease. */
  readonly receipt: string;
  /** The identity of what is delivered (message or event identifier), stable across redeliveries. */
  readonly id: string;
  /** 1 for the first delivery; increases with every lease, including leases that expired. */
  readonly attempt: number;
  readonly body: Body;
  /** Where the delivery came from, when the binding recorded it. */
  readonly trace?: DeliveryTrace;
  /**
   * When the message was sent or the change happened (ISO 8601, UTC), when
   * the binding knows it. Retries keep the original time. Runtimes compare it
   * with `events.maxEventAgeMs`; without it, age limits cannot apply.
   */
  readonly sentAt?: string;
}

/** Settings of one receive call. */
export interface ReceiveRequest {
  /** The most deliveries to return; at least 1. */
  readonly max: number;
  /** How long each returned delivery stays leased to this receiver, in milliseconds. */
  readonly leaseMs: number;
}

/** Why a delivery failed, recorded with retried and dead-lettered deliveries. Safe to show operators. */
export interface DeliveryFailure {
  /** A diagnostic code, for example `HOLQA_HANDLER_FAILED`. */
  readonly code: string;
  readonly message: string;
  /** The attempt that failed. */
  readonly attempt: number;
  /** The invocation that failed, for correlating with logs. */
  readonly invocationId?: string;
}

/**
 * A store of leased deliveries for one consumer. Settlement methods resolve
 * to `false` when the lease was lost (it expired and the delivery was leased
 * again), in which case the settlement has no effect.
 *
 * @typeParam Body - What is delivered.
 */
export interface DeliverySource<Body> {
  /**
   * Leases up to `max` deliveries that are due, oldest first where the
   * binding can tell. Resolves to an empty list when none is due.
   */
  readonly receive: (request: ReceiveRequest) => Promise<ReadonlyArray<LeasedDelivery<Body>>>;
  /** Marks a delivery as processed; it is never delivered again (barring duplicates the binding cannot rule out). */
  readonly acknowledge: (receipt: string) => Promise<boolean>;
  /**
   * Releases a delivery for another attempt after `delayMs` milliseconds. A
   * source must honour the delay (delivering later is allowed, earlier is
   * not) or reject; it must never shorten it silently. The runtime only asks
   * for delays within the binding's advertised `maxDelaySeconds`.
   */
  readonly retry: (receipt: string, delayMs: number, failure: DeliveryFailure) => Promise<boolean>;
  /** Moves a delivery to the dead-letter destination, where operators can inspect and redrive it. */
  readonly deadLetter: (receipt: string, failure: DeliveryFailure) => Promise<boolean>;
  /** Drops a delivery that exhausted its attempts when no dead-letter destination is required. */
  readonly discard: (receipt: string, failure: DeliveryFailure) => Promise<boolean>;
  /**
   * Extends a held lease to `leaseMs` from now, so a long-running handler
   * keeps its delivery. Resolves to `false` when the lease was already lost.
   * Optional: without it, the runtime cannot renew leases, and a handler that
   * outlives its lease may run again concurrently.
   */
  readonly extend?: (receipt: string, leaseMs: number) => Promise<boolean>;
  /**
   * Resolves when a receive may return deliveries: something was added,
   * a delay or lease ran out, or the binding's polling interval passed.
   * Resolves at once when `signal` is aborted. Spurious wake-ups are allowed.
   */
  readonly wait: (signal: AbortSignal) => Promise<void>;
}

/** The deliveries of one queue, in `holqa.message/1` envelopes. */
export interface QueueSource extends DeliverySource<MessageEnvelope> {
  /** The attempts the binding allows when a queue declares no `maxAttempts`. */
  readonly defaultMaxAttempts: number;
  /**
   * Counts the messages waiting in the queue: ready, delayed and in flight,
   * not dead-lettered. Optional: a runtime reports the queue backlog metric
   * only for bindings that provide it, and the count may be approximate.
   */
  readonly pending?: () => Promise<number>;
}

/** Which object events one handler receives. */
export interface ObjectEventSubscription {
  /** The subscribing handler's identifier. Each subscription has its own delivery state. */
  readonly id: string;
  readonly types: readonly ObjectEventType[];
  /** Only objects whose key starts with this prefix. */
  readonly prefix?: string;
}

/**
 * The object events of one bucket. Every subscription receives its own copy
 * of each matching event and settles it independently, so one failing handler
 * never blocks or repeats another.
 */
export interface ObjectEventSource {
  /**
   * Attaches to one subscription's deliveries. For external services the
   * subscription (a notification configuration) is infrastructure created by
   * provisioning; a driver must fail with a diagnostic when it is missing or
   * its filter differs, never create it with data-plane credentials. A local
   * binding, which is its own provisioner, may create it. Events that
   * happened before a subscription existed are not delivered to it.
   */
  readonly subscribe: (subscription: ObjectEventSubscription) => Promise<DeliverySource<ObjectEvent>>;
}

/** One due run of a schedule, as a scheduler reports it to the runtime. */
export interface ScheduleTick {
  /** Identifies the run in the scheduler's records. */
  readonly runId: string;
  /** The time the run was due (ISO 8601, UTC); for a manual run, when it was requested. */
  readonly scheduledTime: string;
  readonly trigger: ScheduleRunTrigger;
}

/** How a scheduled run ended. */
export type ScheduleRunStatus = "succeeded" | "failed" | "skipped";

/** A run whose handler finished successfully. */
export interface SucceededScheduleRun {
  readonly status: "succeeded";
  /** The invocation that ran, for correlating with logs. */
  readonly invocationId: string;
}

/** A run whose handler failed, or that could not be started. */
export interface FailedScheduleRun {
  readonly status: "failed";
  /** A diagnostic code, for example `HOLQA_HANDLER_FAILED`. */
  readonly code: string;
  /** A message safe to show operators. */
  readonly message: string;
  /** The invocation that ran; absent when none was started. */
  readonly invocationId?: string;
  readonly details?: JsonObject;
}

/** A run that was not started, for example because of the overlap policy. */
export interface SkippedScheduleRun {
  readonly status: "skipped";
  /** Why, for example `HOLQA_SCHEDULE_RUN_SKIPPED`. */
  readonly code: string;
  readonly message: string;
}

/** The outcome of one scheduled run, as the runtime reports it back to the scheduler, discriminated by `status`. */
export type ScheduleRunResult = SucceededScheduleRun | FailedScheduleRun | SkippedScheduleRun;

/** Called by a scheduler for every due run; resolves once the run has finished or was skipped. */
export type ScheduleListener = (tick: ScheduleTick) => Promise<ScheduleRunResult>;

/** A running subscription to a scheduler. */
export interface ScheduleSubscription {
  /** Stops reporting ticks. Runs already reported are not affected. */
  readonly stop: () => Promise<void>;
}

/**
 * The due runs of one schedule. The scheduler decides when a run is due
 * (cron, time zone, missed runs); the runtime applies the overlap policy and
 * reports every run's result back through the listener's promise.
 */
export interface ScheduleSource {
  readonly start: (listener: ScheduleListener) => Promise<ScheduleSubscription>;
}

/**
 * Source factories by resource kind. A binding that has no source for a kind
 * cannot deliver its triggers: a runtime then refuses to start an application
 * with handlers for that kind, rather than leave them silently undelivered.
 */
export interface ResourceSources {
  readonly queue?: (resource: ResourceDescriptorOf<"queue">) => QueueSource;
  readonly bucket?: (resource: ResourceDescriptorOf<"bucket">) => ObjectEventSource;
  readonly schedule?: (resource: ResourceDescriptorOf<"schedule">) => ScheduleSource;
}