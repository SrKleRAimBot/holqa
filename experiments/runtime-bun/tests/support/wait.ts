/**
 * Polls a condition until it holds, for state that changes in another thread
 * or after unobservable microtasks. Fails instead of hanging.
 *
 * @param condition - The condition to wait for.
 * @param timeoutMs - How long to wait before failing.
 * @throws {Error} When the condition does not hold within `timeoutMs`.
 */
export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error("Condition not met in time.");
    await Bun.sleep(1);
  }
}

/**
 * Captures the diagnostic code a promise rejects with.
 *
 * @param promise - A promise expected to reject with a Holqa error.
 * @returns The diagnostic code, or `"resolved"` when the promise resolved.
 */
export async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    const diagnostic = (error as { readonly diagnostic?: { readonly code?: string } }).diagnostic;
    return diagnostic?.code ?? "no-code";
  }
}

/**
 * Reads a per-handler counter from a stats record. A helper avoids a conflict
 * between ESLint's dot-notation autofix and TypeScript's
 * `noPropertyAccessFromIndexSignature` for identifier-like keys.
 *
 * @param record - A per-handler counter record from `runtime.stats()`.
 * @param handlerId - The handler identifier.
 * @returns The counter, or `undefined` when the handler has no entry.
 */
export function counter(record: Readonly<Record<string, number>>, handlerId: string): number | undefined {
  return record[handlerId];
}