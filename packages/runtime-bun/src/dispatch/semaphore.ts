/** A waiting acquirer in a {@link Semaphore}'s FIFO queue. */
interface Waiter {
  readonly grant: (release: () => void) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

/** Thrown by {@link Semaphore.acquire} when the wait queue is full. */
export class SemaphoreFullError extends Error {
  /**
   * Creates the error.
   *
   * @param limit - The concurrency limit that was reached.
   * @param queueLimit - The wait queue limit that was reached.
   */
  constructor(limit: number, queueLimit: number) {
    super(`All ${limit} slots are in use and ${queueLimit} invocations are already waiting.`);
    this.name = "SemaphoreFullError";
  }
}

/**
 * A counting semaphore with a bounded FIFO wait queue and cancellable waits:
 * the runtime's concurrency gate. Slots are released only when the work that
 * holds them finishes, so cancellation never lets concurrency exceed the limit.
 */
export class Semaphore {
  /** Maximum concurrent holders. */
  private readonly limit: number;
  /** Maximum waiting acquirers. */
  private readonly queueLimit: number;
  /** Slots currently held. */
  private active = 0;
  /** The highest number of slots held at once. */
  private peakValue = 0;
  /** Acquirers waiting for a slot, in arrival order. */
  private readonly waiters: Waiter[] = [];

  /**
   * Creates a semaphore.
   *
   * @param limit - Maximum concurrent holders; `Infinity` for no limit.
   * @param queueLimit - Maximum waiting acquirers; `Infinity` for no limit.
   */
  constructor(limit: number, queueLimit = Number.POSITIVE_INFINITY) {
    this.limit = limit;
    this.queueLimit = queueLimit;
  }

  /** The number of slots currently held. */
  get held(): number {
    return this.active;
  }

  /** The highest number of slots ever held at the same time. */
  get peak(): number {
    return this.peakValue;
  }

  /** The number of acquirers waiting for a slot. */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Waits for a slot. Waiters are served in arrival order.
   *
   * @param signal - Aborting it removes the waiter from the queue and rejects with the signal's reason.
   * @returns A release function; calling it more than once has no further effect.
   * @throws {SemaphoreFullError} When every slot is held and the wait queue is full.
   * @throws The signal's abort reason when the signal aborts before a slot is granted.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limit && this.waiters.length === 0)
      return this.take();
    if (this.waiters.length >= this.queueLimit)
      throw new SemaphoreFullError(this.limit, this.queueLimit);
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1)
            this.waiters.splice(index, 1);
          reject(signal?.reason);
        }
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /**
   * Takes a slot and returns its idempotent release function.
   *
   * @returns The release function.
   */
  private take(): () => void {
    this.active += 1;
    this.peakValue = Math.max(this.peakValue, this.active);
    let released = false;
    return () => {
      if (released)
        return;
      released = true;
      this.active -= 1;
      this.grantWaiting();
    };
  }

  /** Grants slots to waiters, in order, while the limit allows. */
  private grantWaiting(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.grant(this.take());
    }
  }
}