/** A waiting acquirer in a {@link Semaphore}'s FIFO queue. */
interface Waiter {
  readonly grant: (release: () => void) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

/**
 * A counting semaphore with a FIFO wait queue, cancellable waits and an
 * adjustable limit. It is the runtime's per-handler concurrency gate.
 */
export class Semaphore {
  private limitValue: number;
  private active = 0;
  private peakValue = 0;
  private readonly waiters: Waiter[] = [];

  /**
   * Creates a semaphore.
   *
   * @param limit - Maximum concurrent holders; `Infinity` for no limit.
   */
  constructor(limit: number) {
    this.limitValue = limit;
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
   * Changes the limit, for example when a reload changes a handler's
   * concurrency. Lowering the limit never revokes held slots; it only delays
   * new grants until enough holders release.
   *
   * @param limit - The new maximum concurrent holders.
   */
  setLimit(limit: number): void {
    this.limitValue = limit;
    this.grantWaiting();
  }

  /**
   * Waits for a slot. Waiters are served in arrival order.
   *
   * @param signal - Aborting it removes the waiter from the queue and rejects.
   * @returns A release function; calling it more than once has no further effect.
   * @throws The signal's abort reason when the signal aborts before a slot is granted.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limitValue && this.waiters.length === 0)
      return this.take();
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
    while (this.active < this.limitValue && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter === undefined)
        return;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.grant(this.take());
    }
  }
}