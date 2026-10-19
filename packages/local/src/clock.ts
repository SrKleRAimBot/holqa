/**
 * The time source of the local drivers: delays, leases, signed URL expiry and
 * schedules all read it, so tests can control time instead of waiting for it.
 */
export interface Clock {
  /** The current time in epoch milliseconds. */
  readonly now: () => number;
  /**
   * Calls `callback` once after `delayMs` milliseconds of this clock's time.
   *
   * @returns A function that cancels the timer; calling it after the timer fired is harmless.
   */
  readonly setTimer: (delayMs: number, callback: () => void) => () => void;
}

/** The longest delay a platform timer can represent; longer timers are re-armed. */
const maxTimerDelay = 2_147_483_647;

/** The wall clock: `Date.now()` and platform timers. */
export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  setTimer: (delayMs: number, callback: () => void) => {
    const due = Date.now() + Math.max(0, delayMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Arms the platform timer for the remaining delay, re-arming delays a platform timer cannot represent. */
    const arm = (): void => {
      const remaining = due - Date.now();
      timer = setTimeout(remaining > maxTimerDelay ? arm : callback, Math.min(Math.max(0, remaining), maxTimerDelay));
    };
    arm();
    return () => clearTimeout(timer);
  }
});

/** A pending timer of a {@link ManualClock}. */
interface ManualTimer {
  readonly due: number;
  readonly order: number;
  readonly callback: () => void;
}

/**
 * A clock that only moves when told to, for deterministic tests. Timers fire
 * synchronously, in due order, while the clock is advanced.
 *
 * @example
 * ```ts
 * const clock = new ManualClock(Date.parse("2026-10-18T00:00:00Z"));
 * const env = await createLocalEnvironment({ app, directory, clock });
 * clock.advance(60_000); // fires every timer due within the next minute, in order
 * ```
 */
export class ManualClock implements Clock {
  /** The current time. */
  private time: number;
  /** Pending timers. */
  private timers: ManualTimer[] = [];
  /** Creation order, so timers due at the same time fire in the order they were set. */
  private sequence = 0;

  /**
   * Creates a clock that starts at a fixed time.
   *
   * @param start - The initial time in epoch milliseconds. Defaults to 2026-01-01T00:00:00Z.
   */
  constructor(start = Date.UTC(2026, 0, 1)) {
    this.time = start;
  }

  /**
   * Returns the clock's current time.
   *
   * @returns Epoch milliseconds.
   */
  readonly now = (): number => this.time;

  /**
   * Schedules a callback at the clock's current time plus a delay.
   *
   * @param delayMs - The delay in milliseconds; negative delays fire at the next advance.
   * @param callback - Called once when the timer is due.
   * @returns A function that cancels the timer.
   */
  readonly setTimer = (delayMs: number, callback: () => void): (() => void) => {
    const timer: ManualTimer = { due: this.time + Math.max(0, delayMs), order: this.sequence++, callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter(candidate => candidate !== timer);
    };
  };

  /**
   * Moves time forward continuously: every timer due within the period fires
   * at its own due time, in order, including timers those callbacks set.
   *
   * @param ms - How far to move, in milliseconds; at least 0.
   */
  advance(ms: number): void {
    const target = this.time + Math.max(0, ms);
    for (;;) {
      const next = this.nextTimer();
      if (next === undefined || next.due > target)
        break;
      this.time = Math.max(this.time, next.due);
      this.fire(next);
    }
    this.time = target;
  }

  /**
   * Moves time forward in one step, as when a process was suspended or its
   * event loop was blocked: the clock jumps first, then every due timer fires
   * once, late. Schedulers see the occurrences they missed.
   *
   * @param ms - How far to jump, in milliseconds; at least 0.
   */
  jump(ms: number): void {
    this.time += Math.max(0, ms);
    const due = this.timers.filter(timer => timer.due <= this.time).sort(compareTimers);
    for (const timer of due) {
      if (this.timers.includes(timer))
        this.fire(timer);
    }
  }

  /**
   * Returns when the earliest pending timer is due, so a test can move time
   * exactly to the next piece of scheduled work.
   *
   * @returns Epoch milliseconds, or `undefined` when no timer is pending.
   */
  nextTimerDue(): number | undefined {
    return this.nextTimer()?.due;
  }

  /**
   * Returns the number of pending timers.
   *
   * @returns How many timers have not fired or been cancelled.
   */
  pendingTimers(): number {
    return this.timers.length;
  }

  /**
   * Returns the earliest pending timer.
   *
   * @returns The timer, or `undefined` when none is pending.
   */
  private nextTimer(): ManualTimer | undefined {
    return [...this.timers].sort(compareTimers)[0];
  }

  /**
   * Removes a timer and calls it.
   *
   * @param timer - The due timer.
   */
  private fire(timer: ManualTimer): void {
    this.timers = this.timers.filter(candidate => candidate !== timer);
    timer.callback();
  }
}

/**
 * Orders timers by due time, then by creation.
 *
 * @param left - One timer.
 * @param right - Another timer.
 * @returns A negative number when `left` fires first.
 */
function compareTimers(left: ManualTimer, right: ManualTimer): number {
  return left.due - right.due || left.order - right.order;
}