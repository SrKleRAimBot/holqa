/** A test-controlled gate that an in-process fixture handler waits on. */
export interface Latch {
  /** Resolves when the handler has started. */
  readonly started: Promise<void>;
  /** Called by the handler when it starts, with the module state of its generation. */
  readonly markStarted: (state: LatchState) => void;
  /** The module state of the generation the handler started in. */
  startedWith: LatchState | undefined;
  /** Resolves when the test releases the handler. */
  readonly released: Promise<void>;
  /** Called by the test to let the handler finish. */
  readonly release: () => void;
  /** What the handler observed, recorded when it finishes. */
  finished: LatchState | undefined;
}

/** Module state a fixture handler reports. */
export interface LatchState {
  readonly version: string;
  readonly evaluation: number;
}

/** Latches by key, shared through `globalThis` so fixture modules of any generation see them. */
const registry = globalThis as { __holqaLatches?: Map<string, Latch> };

/**
 * Returns the latch for a key, creating it on first use.
 *
 * @param key - The latch key, chosen by the test.
 * @returns The shared latch.
 */
export function latch(key: string): Latch {
  registry.__holqaLatches ??= new Map();
  let existing = registry.__holqaLatches.get(key);
  if (existing === undefined) {
    const { promise: started, resolve: resolveStarted } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const created: Latch = {
      started,
      markStarted: (state) => {
        created.startedWith = state;
        resolveStarted();
      },
      startedWith: undefined,
      released,
      release,
      finished: undefined
    };
    existing = created;
    registry.__holqaLatches.set(key, existing);
  }
  return existing;
}