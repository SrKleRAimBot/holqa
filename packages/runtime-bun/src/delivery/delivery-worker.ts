import type {
  DeliveryFailure,
  DeliverySource,
  DiagnosticCode,
  JsonObject,
  LeasedDelivery,
  QueueBackoff
} from "@holqa/core";

import type {
  InvocationOutcome,
  InvocationRequest
} from "@/dispatch/dispatcher";
import type { StructuredLogger } from "@/logging/log";

import {
  backoffDelaySeconds,
  diagnosticCodes
} from "@holqa/core";

import { describeError } from "@/logging/log";

/** How a consumer treats failed deliveries. */
export interface DeliveryPolicy {
  /** Total attempts, including the first. */
  readonly maxAttempts: number;
  readonly backoff: QueueBackoff;
  /** Whether exhausted deliveries are dead-lettered (`true`) or discarded (`false`). */
  readonly deadLetter: boolean;
}

/**
 * What a delivery becomes: an invocation, a delivery to skip, a failed attempt
 * that a later attempt may fix (`fail`), or a failure that retrying cannot fix (`reject`).
 */
export type PreparedDelivery
  = | { readonly kind: "invoke"; readonly input: unknown; readonly metadata: object }
    | { readonly kind: "skip"; readonly reason: string }
    | { readonly kind: "fail"; readonly code: DiagnosticCode; readonly message: string }
    | { readonly kind: "reject"; readonly code: DiagnosticCode; readonly message: string };

/** Counters of one worker, or of all of them. */
export interface DeliveryStats {
  readonly received: number;
  readonly acknowledged: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly discarded: number;
  /** Deliveries released for another attempt because the runtime stopped while they ran. */
  readonly released: number;
  /** Settlements that had no effect because the lease had already expired. */
  readonly leasesLost: number;
}

/** Settings of a {@link DeliveryWorker}. */
export interface DeliveryWorkerOptions<Body> {
  /** The handler every delivery invokes. */
  readonly handlerId: string;
  readonly source: DeliverySource<Body>;
  readonly policy: DeliveryPolicy;
  /** The most deliveries in flight at once. */
  readonly concurrency: number;
  /** How long each delivery stays leased, in milliseconds. */
  readonly leaseMs: number;
  /** The time limit of each invocation, in milliseconds. */
  readonly timeoutMs: number;
  /** Turns a delivery into an invocation. Throwing is treated as a non-retryable rejection. */
  readonly prepare: (delivery: LeasedDelivery<Body>) => Promise<PreparedDelivery>;
  readonly dispatch: (request: InvocationRequest) => Promise<InvocationOutcome>;
  /** Whether the runtime is stopping, so that cancelled deliveries are released rather than counted as failures. */
  readonly stopping: () => boolean;
  readonly logger: StructuredLogger;
  /** Waits before retrying after the source failed; resolves early when `signal` aborts. Defaults to one second. */
  readonly pause?: (signal: AbortSignal) => Promise<void>;
}

/** Codes that mean the runtime, not the handler, ended the invocation during shutdown. */
const shutdownCodes: ReadonlySet<string> = new Set([diagnosticCodes.runtimeNotRunning, diagnosticCodes.invocationCancelled]);

/**
 * Pulls deliveries from one source and runs them through the dispatcher,
 * applying the consumer's delivery policy: successful deliveries are
 * acknowledged; failed ones are retried after the policy's backoff until
 * their attempts are exhausted, then dead-lettered or discarded; deliveries
 * that cannot succeed (an invalid payload, an unsupported schema version) are
 * dead-lettered or discarded at once.
 *
 * At most `concurrency` deliveries are leased at a time, so a slow handler
 * never holds leases it cannot work on.
 */
export class DeliveryWorker<Body> {
  /** Settings. */
  private readonly options: DeliveryWorkerOptions<Body>;
  /** Aborted when the worker stops receiving. */
  private readonly controller = new AbortController();
  /** Settlement tasks of deliveries in flight. */
  private readonly tasks = new Set<Promise<void>>();
  /** Resolves the current wait for a free slot. */
  private slotFreed: (() => void) | undefined;
  /** The receive loop, once started. */
  private loop: Promise<void> | undefined;
  /** Counters. */
  private counts = { received: 0, acknowledged: 0, retried: 0, deadLettered: 0, discarded: 0, released: 0, leasesLost: 0 };

  /**
   * Creates a worker; nothing happens until {@link start}.
   *
   * @param options - The source, policy, limits and dispatcher.
   */
  constructor(options: DeliveryWorkerOptions<Body>) {
    this.options = options;
  }

  /** Starts receiving. Calling it again has no effect. */
  start(): void {
    this.loop ??= this.run();
  }

  /**
   * Stops receiving new deliveries. Deliveries in flight keep running; wait
   * for them with {@link settled}.
   *
   * @returns A promise that settles once the receive loop has exited.
   */
  async stopReceiving(): Promise<void> {
    this.controller.abort();
    this.slotFreed?.();
    await this.loop;
  }

  /**
   * Waits until every delivery in flight has been settled with its source.
   *
   * @returns A promise that settles when no settlement is pending.
   */
  async settled(): Promise<void> {
    while (this.tasks.size > 0)
      await Promise.allSettled([...this.tasks]);
  }

  /**
   * Returns the worker's counters.
   *
   * @returns A snapshot.
   */
  stats(): DeliveryStats {
    return Object.freeze({ ...this.counts });
  }

  /**
   * The receive loop: lease as many deliveries as there are free slots, start
   * each one, and wait for the source when nothing is due.
   *
   * @returns A promise that settles when the worker stops receiving.
   */
  private async run(): Promise<void> {
    const { signal } = this.controller;
    const { source, concurrency, leaseMs, logger } = this.options;
    while (!signal.aborted) {
      if (this.tasks.size >= concurrency) {
        await new Promise<void>((resolve) => {
          this.slotFreed = resolve;
        });
        this.slotFreed = undefined;
        continue;
      }
      let deliveries: ReadonlyArray<LeasedDelivery<Body>>;
      try {
        deliveries = await source.receive({ max: concurrency - this.tasks.size, leaseMs });
      } catch (error) {
        logger.write("error", "receiving deliveries failed; retrying", { error: describeError(error) });
        await (this.options.pause ?? pauseOneSecond)(signal);
        continue;
      }
      if (deliveries.length === 0) {
        try {
          await source.wait(signal);
        } catch (error) {
          logger.write("error", "waiting for deliveries failed; retrying", { error: describeError(error) });
          await (this.options.pause ?? pauseOneSecond)(signal);
        }
        continue;
      }
      for (const delivery of deliveries) {
        this.counts.received += 1;
        const task = this.deliver(delivery).finally(() => {
          this.tasks.delete(task);
          this.slotFreed?.();
        });
        this.tasks.add(task);
      }
    }
  }

  /**
   * Runs one delivery and settles it with the source. Never rejects: a
   * failed settlement is logged, and the lease then expires so the delivery
   * runs again, which at-least-once delivery allows.
   *
   * @param delivery - The leased delivery.
   * @returns A promise that settles once the delivery is settled.
   */
  private async deliver(delivery: LeasedDelivery<Body>): Promise<void> {
    const { policy, handlerId, timeoutMs, logger } = this.options;
    const log = logger.child({ handlerId, deliveryId: delivery.id, attempt: delivery.attempt });
    try {
      if (delivery.attempt > policy.maxAttempts) {
        await this.exhaust(delivery, { code: diagnosticCodes.deliveryAttemptsExhausted, message: `The delivery was received ${delivery.attempt} times without being settled; at most ${policy.maxAttempts} attempts are allowed.`, attempt: delivery.attempt }, log);
        return;
      }
      let prepared: PreparedDelivery;
      try {
        prepared = await this.options.prepare(delivery);
      } catch (error) {
        log.write("error", "a delivery could not be read", { error: describeError(error) });
        prepared = { kind: "reject", code: diagnosticCodes.payloadMalformed, message: "The delivery could not be read." };
      }
      if (prepared.kind === "skip") {
        log.write("debug", "delivery skipped", { reason: prepared.reason });
        await this.settle(delivery, "acknowledged", () => this.options.source.acknowledge(delivery.receipt), log);
        return;
      }
      if (prepared.kind === "reject") {
        log.write("warn", "a delivery cannot be processed and is not retried", { code: prepared.code });
        await this.exhaust(delivery, { code: prepared.code, message: prepared.message, attempt: delivery.attempt }, log);
        return;
      }
      let failure: DeliveryFailure;
      if (prepared.kind === "fail") {
        failure = { code: prepared.code, message: prepared.message, attempt: delivery.attempt };
      } else {
        const outcome = await this.withRenewedLease(delivery, log, () => this.options.dispatch({
          handlerId,
          input: prepared.input,
          metadata: prepared.metadata,
          correlationId: delivery.id,
          timeoutMs,
          logFields: { deliveryId: delivery.id, attempt: delivery.attempt }
        }));
        if (outcome.ok) {
          await this.settle(delivery, "acknowledged", () => this.options.source.acknowledge(delivery.receipt), log);
          return;
        }
        failure = { code: outcome.failure.code, message: outcome.failure.message, attempt: delivery.attempt, invocationId: outcome.invocationId };
      }
      if (this.options.stopping() && shutdownCodes.has(failure.code)) {
        await this.settle(delivery, "released", () => this.options.source.retry(delivery.receipt, 0, failure), log);
        return;
      }
      if (delivery.attempt >= policy.maxAttempts) {
        await this.exhaust(delivery, failure, log);
        return;
      }
      const delayMs = backoffDelaySeconds(policy.backoff, delivery.attempt) * 1000;
      log.write("info", "delivery failed; retrying", { code: failure.code, delayMs, maxAttempts: policy.maxAttempts });
      await this.settle(delivery, "retried", () => this.options.source.retry(delivery.receipt, delayMs, failure), log);
    } catch (error) {
      log.write("error", "settling a delivery failed; it is redelivered when its lease expires", { error: describeError(error) });
    }
  }

  /**
   * Runs work while renewing the delivery's lease at half its duration, when
   * the source can extend leases, so a handler that runs longer than one lease
   * does not lose its delivery to another receiver.
   *
   * @param delivery - The leased delivery.
   * @param log - The delivery's logger.
   * @param work - The invocation.
   * @returns The invocation's result.
   */
  private async withRenewedLease<Result>(delivery: LeasedDelivery<Body>, log: StructuredLogger, work: () => Promise<Result>): Promise<Result> {
    const { source, leaseMs } = this.options;
    const extend = source.extend;
    if (extend === undefined)
      return work();
    const timer = setInterval(() => {
      extend(delivery.receipt, leaseMs).then((held) => {
        if (!held)
          log.write("warn", "the delivery's lease was lost while its handler was running; it may run again", { deliveryId: delivery.id });
      }, (error: unknown) => log.write("error", "extending a lease failed", { error: describeError(error) }));
    }, Math.max(1, Math.floor(leaseMs / 2)));
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Dead-letters or discards a delivery that will not be attempted again.
   *
   * @param delivery - The leased delivery to settle.
   * @param failure - Why it ends.
   * @param log - The delivery's logger.
   * @returns A promise that settles once the source has recorded it.
   */
  private async exhaust(delivery: LeasedDelivery<Body>, failure: DeliveryFailure, log: StructuredLogger): Promise<void> {
    const { source, policy } = this.options;
    const fields: JsonObject = { code: failure.code, maxAttempts: policy.maxAttempts };
    if (policy.deadLetter) {
      log.write("warn", "delivery dead-lettered", fields);
      await this.settle(delivery, "deadLettered", () => source.deadLetter(delivery.receipt, failure), log);
    } else {
      log.write("warn", "delivery discarded after its last attempt; no dead-letter destination is required", fields);
      await this.settle(delivery, "discarded", () => source.discard(delivery.receipt, failure), log);
    }
  }

  /**
   * Applies one settlement and counts it, or records that the lease was lost.
   *
   * @param delivery - The leased delivery being settled.
   * @param counter - Which counter a successful settlement increments.
   * @param apply - Performs the settlement.
   * @param log - The delivery's logger.
   * @returns A promise that settles after the settlement.
   */
  private async settle(delivery: LeasedDelivery<Body>, counter: "acknowledged" | "retried" | "deadLettered" | "discarded" | "released", apply: () => Promise<boolean>, log: StructuredLogger): Promise<void> {
    if (await apply()) {
      this.counts[counter] += 1;
      return;
    }
    this.counts.leasesLost += 1;
    log.write("warn", "the delivery's lease expired before it was settled; it may run again", { deliveryId: delivery.id });
  }
}

/**
 * Waits one second, or less when the signal aborts.
 *
 * @param signal - Ends the wait early.
 * @returns A promise that settles after the pause.
 */
async function pauseOneSecond(signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, 1_000);
    /** Ends the pause and stops listening. */
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Adds up the counters of several workers.
 *
 * @param stats - The counters to add.
 * @returns The totals.
 */
export function sumDeliveryStats(stats: readonly DeliveryStats[]): DeliveryStats {
  const total = { received: 0, acknowledged: 0, retried: 0, deadLettered: 0, discarded: 0, released: 0, leasesLost: 0 };
  for (const entry of stats) {
    for (const key of Object.keys(total) as Array<keyof DeliveryStats>)
      total[key] += entry[key];
  }
  return Object.freeze(total);
}