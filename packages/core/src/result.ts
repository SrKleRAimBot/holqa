/**
 * A successful outcome carrying a value.
 *
 * @typeParam T - The type of the successful value.
 */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/**
 * A failed outcome carrying an error description.
 *
 * @typeParam E - The type describing the failure.
 */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * A discriminated union describing either success or failure without throwing.
 *
 * Holqa uses `Result` for expected, recoverable failures (for example invalid
 * user input) and reserves exceptions for programmer errors and invariants.
 *
 * @typeParam T - The type of the successful value.
 * @typeParam E - The type describing the failure.
 */
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Wraps a value in a successful {@link Result}.
 *
 * @param value - The successful value.
 * @returns A frozen `Ok` result containing `value`.
 */
export function ok<T>(value: T): Ok<T> {
  return Object.freeze({ ok: true, value });
}

/**
 * Wraps an error description in a failed {@link Result}.
 *
 * @param error - The failure description.
 * @returns A frozen `Err` result containing `error`.
 */
export function err<E>(error: E): Err<E> {
  return Object.freeze({ ok: false, error });
}