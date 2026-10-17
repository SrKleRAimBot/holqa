/** Process-wide evaluation counter shared by every module graph in the same thread. */
const counter = globalThis as { __holqaFixtureEvaluations?: number };
counter.__holqaFixtureEvaluations = (counter.__holqaFixtureEvaluations ?? 0) + 1;

/** Which evaluation of this module (in this thread) the current module graph uses. */
export const evaluation = counter.__holqaFixtureEvaluations;

/** The code version; reload tests rewrite this line. */
export const version = "v1";

let calls = 0;

/**
 * Counts calls in this module instance. A fresh module graph starts again at 1.
 *
 * @returns The number of calls so far, including this one.
 */
export function nextCall(): number {
  calls += 1;
  return calls;
}