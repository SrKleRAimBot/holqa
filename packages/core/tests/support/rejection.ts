/**
 * Awaits a promise that must reject and returns the rejection reason.
 *
 * @param promise - The promise expected to reject.
 * @returns The rejection reason, typed as the expected error.
 * @throws {Error} When the promise resolves instead.
 */
export async function rejectionOf<E>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (error) {
    return error as E;
  }
  throw new Error("Expected the promise to reject.");
}