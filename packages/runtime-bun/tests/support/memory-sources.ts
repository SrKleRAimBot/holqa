import type {
  DeliveryFailure,
  DeliverySource,
  LeasedDelivery,
  ReceiveRequest,
  ScheduleListener,
  ScheduleRunResult,
  ScheduleSource,
  ScheduleTick
} from "@holqa/core";

/** One recorded settlement of a {@link MemorySource}. */
export interface Settlement {
  readonly kind: "acknowledge" | "retry" | "deadLetter" | "discard";
  readonly id: string;
  readonly attempt: number;
  readonly delayMs?: number;
  readonly failure?: DeliveryFailure;
}

/** A stored delivery. */
interface Item<Body> {
  readonly id: string;
  readonly body: Body;
  attempt: number;
  visibleAt: number;
  state: "ready" | "leased" | "done";
  receipt?: string;
}

/**
 * An in-memory delivery source with a manual clock, for testing runtime
 * transports without a real binding. It records every settlement and every
 * receive request.
 *
 * @typeParam Body - What it delivers.
 */
export class MemorySource<Body> implements DeliverySource<Body> {
  /** Every settlement, in order. */
  readonly settlements: Settlement[] = [];
  /** Every receive request, in order. */
  readonly requests: ReceiveRequest[] = [];
  /** The attempts the source allows by default, for queue sources. */
  readonly defaultMaxAttempts = 3;
  /** Stored deliveries. */
  private readonly items: Array<Item<Body>> = [];
  /** Resolvers of pending waits. */
  private waiters: Array<() => void> = [];
  /** The manual clock, in milliseconds. */
  private now = 0;
  /** Issued receipts. */
  private receipts = 0;

  /**
   * Adds a delivery.
   *
   * @param id - Its identity.
   * @param body - What it delivers.
   * @param attempt - Attempts already made, to simulate expired leases.
   */
  add(id: string, body: Body, attempt = 0): void {
    this.items.push({ id, body, attempt, visibleAt: this.now, state: "ready" });
    this.wake();
  }

  /**
   * Advances the manual clock, making delayed deliveries due.
   *
   * @param ms - How far to advance.
   */
  advance(ms: number): void {
    this.now += ms;
    this.wake();
  }

  /**
   * Waits until no delivery is due or leased.
   *
   * @returns A promise that settles once the source is quiet.
   */
  async drained(): Promise<void> {
    for (let round = 0; round < 2_000; round += 1) {
      if (!this.items.some(item => item.state === "leased" || (item.state === "ready" && item.visibleAt <= this.now)))
        return;
      await Bun.sleep(1);
    }
    throw new Error("The source did not drain.");
  }

  /**
   * Leases due deliveries.
   *
   * @param request - How many, and for how long.
   * @returns The leased deliveries.
   */
  async receive(request: ReceiveRequest): Promise<ReadonlyArray<LeasedDelivery<Body>>> {
    this.requests.push(request);
    const due = this.items.filter(item => item.state === "ready" && item.visibleAt <= this.now).slice(0, request.max);
    return due.map((item) => {
      item.state = "leased";
      item.attempt += 1;
      item.receipt = `r-${++this.receipts}`;
      return { receipt: item.receipt, id: item.id, attempt: item.attempt, body: item.body };
    });
  }

  /**
   * Acknowledges a delivery.
   *
   * @param receipt - Its receipt.
   * @returns Whether the lease was still held.
   */
  async acknowledge(receipt: string): Promise<boolean> {
    return this.settle(receipt, "acknowledge", item => item.state = "done");
  }

  /**
   * Releases a delivery for another attempt.
   *
   * @param receipt - Its receipt.
   * @param delayMs - When it becomes due again.
   * @param failure - Why it failed.
   * @returns Whether the lease was still held.
   */
  async retry(receipt: string, delayMs: number, failure: DeliveryFailure): Promise<boolean> {
    return this.settle(receipt, "retry", (item) => {
      item.state = "ready";
      item.visibleAt = this.now + delayMs;
    }, { delayMs, failure });
  }

  /**
   * Dead-letters a delivery.
   *
   * @param receipt - Its receipt.
   * @param failure - Why it failed.
   * @returns Whether the lease was still held.
   */
  async deadLetter(receipt: string, failure: DeliveryFailure): Promise<boolean> {
    return this.settle(receipt, "deadLetter", item => item.state = "done", { failure });
  }

  /**
   * Discards a delivery.
   *
   * @param receipt - Its receipt.
   * @param failure - Why it failed.
   * @returns Whether the lease was still held.
   */
  async discard(receipt: string, failure: DeliveryFailure): Promise<boolean> {
    return this.settle(receipt, "discard", item => item.state = "done", { failure });
  }

  /**
   * Waits for a change or an abort.
   *
   * @param signal - Ends the wait.
   * @returns A promise that settles on the next change.
   */
  async wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted)
      return;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  /**
   * Applies and records a settlement.
   *
   * @param receipt - The delivery's receipt.
   * @param kind - The settlement.
   * @param apply - Changes the item.
   * @param extra - Recorded details.
   * @returns Whether the receipt matched a leased delivery.
   */
  private settle(receipt: string, kind: Settlement["kind"], apply: (item: Item<Body>) => void, extra: Partial<Settlement> = {}): boolean {
    const item = this.items.find(candidate => candidate.receipt === receipt && candidate.state === "leased");
    if (item === undefined)
      return false;
    this.settlements.push({ kind, id: item.id, attempt: item.attempt, ...extra });
    apply(item);
    this.wake();
    return true;
  }

  /** Resolves every pending wait. */
  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters)
      resolve();
  }
}

/** A schedule source whose ticks are fired by hand. */
export class ManualSchedule implements ScheduleSource {
  /** Results of every run, in completion order. */
  readonly results: Array<{ readonly tick: ScheduleTick; readonly result: ScheduleRunResult }> = [];
  /** The runtime's listener, once started. */
  private listener: ScheduleListener | undefined;

  /**
   * Remembers the runtime's listener.
   *
   * @param listener - Called for every tick.
   * @returns A subscription that forgets the listener.
   */
  async start(listener: ScheduleListener): Promise<{ readonly stop: () => Promise<void> }> {
    this.listener = listener;
    return { stop: async () => {
      this.listener = undefined;
    } };
  }

  /**
   * Fires one tick and records its result.
   *
   * @param runId - The run's identifier.
   * @param trigger - How the run was started.
   * @returns The run's result.
   * @throws {Error} When the runtime has not subscribed.
   */
  async fire(runId: string, trigger: ScheduleTick["trigger"] = "cron"): Promise<ScheduleRunResult> {
    if (this.listener === undefined)
      throw new Error("No runtime is subscribed.");
    const tick = { runId, scheduledTime: "2026-10-18T03:00:00.000Z", trigger };
    const result = await this.listener(tick);
    this.results.push({ tick, result });
    return result;
  }
}