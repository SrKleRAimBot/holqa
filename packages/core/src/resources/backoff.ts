import type { QueueBackoff } from "@/resources/kinds";

/** The backoff the runtime applies when a queue declares none: 1 s, doubling, at most 5 minutes. */
export const defaultQueueBackoff: QueueBackoff = Object.freeze({ strategy: "exponential", initialDelaySeconds: 1, maxDelaySeconds: 300, multiplier: 2 });

/**
 * Describes what is wrong with an untrusted backoff value, using the rules the
 * SDK applies to declarations: non-negative finite delays, a maximum not
 * below the initial delay, and a multiplier of at least 1.
 *
 * @param value - The candidate backoff.
 * @returns A short description of the first problem, or `undefined` for a valid backoff.
 */
export function queueBackoffProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null)
    return "the backoff must be an object";
  const { strategy, delaySeconds, initialDelaySeconds, maxDelaySeconds, multiplier } = value as Readonly<Record<string, unknown>>;
  /**
   * Reports whether a value is a finite number of at least 0.
   *
   * @param seconds - The candidate.
   * @returns `true` for valid delays.
   */
  const isSeconds = (seconds: unknown): seconds is number => typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
  if (strategy === "fixed")
    return isSeconds(delaySeconds) ? undefined : "\"delaySeconds\" must be a number of at least 0";
  if (strategy !== "exponential")
    return "\"strategy\" must be \"fixed\" or \"exponential\"";
  if (!isSeconds(initialDelaySeconds) || !isSeconds(maxDelaySeconds) || maxDelaySeconds < initialDelaySeconds)
    return "\"initialDelaySeconds\" and \"maxDelaySeconds\" must be at least 0, with the maximum not below the initial delay";
  if (multiplier !== undefined && (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 1))
    return "\"multiplier\" must be a number of at least 1";
  return undefined;
}

/**
 * Returns the longest delay a backoff can produce.
 *
 * @param backoff - A valid backoff.
 * @returns The ceiling of an exponential backoff, or the constant delay of a fixed one, in seconds.
 */
export function longestBackoffDelaySeconds(backoff: QueueBackoff): number {
  return backoff.strategy === "fixed" ? backoff.delaySeconds : backoff.maxDelaySeconds;
}

/**
 * Computes how long to wait before redelivering a message after a failed
 * attempt. The result is deterministic (no jitter), so retry schedules can be
 * asserted in tests and reproduced by every binding.
 *
 * @example
 * ```ts
 * const backoff = { strategy: "exponential", initialDelaySeconds: 2, maxDelaySeconds: 60 } as const;
 * backoffDelaySeconds(backoff, 1); // 2  (before attempt 2)
 * backoffDelaySeconds(backoff, 3); // 8  (before attempt 4)
 * backoffDelaySeconds(backoff, 9); // 60 (capped)
 * ```
 *
 * @param backoff - The queue's backoff.
 * @param failedAttempt - The attempt that just failed, starting at 1.
 * @returns The delay in seconds before the next attempt; never negative.
 */
export function backoffDelaySeconds(backoff: QueueBackoff, failedAttempt: number): number {
  if (backoff.strategy === "fixed")
    return Math.max(0, backoff.delaySeconds);
  const exponent = Math.max(0, Math.floor(failedAttempt) - 1);
  const delay = backoff.initialDelaySeconds * (backoff.multiplier ?? 2) ** exponent;
  return Math.max(0, Math.min(backoff.maxDelaySeconds, Number.isFinite(delay) ? delay : backoff.maxDelaySeconds));
}