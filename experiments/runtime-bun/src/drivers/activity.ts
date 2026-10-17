/**
 * Counts background deliveries (queue messages, storage events) so that
 * callers can wait until the runtime has nothing left in progress.
 */
export class Activity {
  private active = 0;
  private waiters: (() => void)[] = [];

  /** The number of deliveries in progress. */
  get count(): number {
    return this.active;
  }

  /**
   * Tracks a delivery until it settles.
   *
   * @param work - The delivery.
   * @returns Settles as the delivery does.
   */
  async track(work: () => Promise<void>): Promise<void> {
    this.active += 1;
    try {
      await work();
    } finally {
      this.active -= 1;
      if (this.active === 0) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const wake of waiters)
          wake();
      }
    }
  }

  /**
   * Waits until no delivery is in progress, including deliveries started by other deliveries.
   *
   * @returns Resolves once the count reaches zero.
   */
  async idle(): Promise<void> {
    while (this.active > 0)
      await new Promise<void>(resolve => this.waiters.push(resolve));
  }
}