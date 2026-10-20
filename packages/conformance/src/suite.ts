// A conformance suite is plain data: named cases, each an async function that
// throws when a provider breaks the contract. Nothing here depends on a test
// runner, so the same cases run under `bun:test`, another runner, or
// `holqa providers test`.

/** Thrown by a conformance case when a provider breaks the contract. */
export class ConformanceFailure extends Error {
  /** The contract the case checks, for example `queue`. */
  readonly contract: string;

  /**
   * Creates a failure.
   *
   * @param contract - The contract being checked.
   * @param message - What the provider did wrong.
   */
  constructor(contract: string, message: string) {
    super(message);
    this.name = "ConformanceFailure";
    this.contract = contract;
  }
}

/** Thrown by a case that does not apply to the provider, for example a dead-letter case for a provider without dead-letter support. */
export class ConformanceSkip extends Error {
  /**
   * Creates a skip.
   *
   * @param reason - Why the case does not apply.
   */
  constructor(reason: string) {
    super(reason);
    this.name = "ConformanceSkip";
  }
}

/**
 * Lets time pass for a conformance run. A harness for a local provider
 * advances its manual clock; a harness for real infrastructure sleeps.
 */
export interface ConformanceTime {
  /** Lets `ms` milliseconds pass. */
  readonly advance: (ms: number) => Promise<void>;
  /** The provider's current time in epoch milliseconds, when it is not the wall clock (a manual clock). Default `Date.now()`. */
  readonly now?: () => number;
}

/**
 * One normative behaviour of a contract.
 *
 * @typeParam Harness - What the case needs to reach the provider.
 */
export interface ConformanceCase<Harness> {
  /** A sentence stating the behaviour, for example `acknowledged messages are not delivered again`. */
  readonly name: string;
  /** Exercises the behaviour; throws `ConformanceFailure` when it is broken and `ConformanceSkip` when it does not apply. */
  readonly run: (harness: Harness) => Promise<void>;
}

/**
 * The cases of one contract.
 *
 * @typeParam Harness - What the cases need to reach the provider.
 */
export interface ConformanceSuite<Harness> {
  /** The contract, for example `queue` or `bucket.events`. */
  readonly contract: string;
  readonly cases: readonly ConformanceCase<Harness>[];
}

/** The outcome of one case. */
export interface ConformanceResult {
  readonly contract: string;
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
  /** Why it failed or was skipped. */
  readonly message?: string;
  readonly durationMs: number;
}

/**
 * Runs every case of a suite, one after another, and reports each outcome.
 * A case that throws anything other than `ConformanceSkip` fails.
 *
 * @param suite - The conformance cases of one contract.
 * @param harness - What the cases need.
 * @returns One result per case, in order.
 */
export async function runConformance<Harness>(suite: ConformanceSuite<Harness>, harness: Harness): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const entry of suite.cases) {
    const started = performance.now();
    try {
      await entry.run(harness);
      results.push({ contract: suite.contract, name: entry.name, status: "passed", durationMs: performance.now() - started });
    } catch (error) {
      const skipped = error instanceof ConformanceSkip;
      results.push({ contract: suite.contract, name: entry.name, status: skipped ? "skipped" : "failed", message: error instanceof Error ? error.message : String(error), durationMs: performance.now() - started });
    }
  }
  return results;
}

/** The parts of a test runner that `registerConformance` needs, as `bun:test`, Vitest and Jest provide them. */
export interface TestRunner {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => Promise<void>, timeoutMs?: number) => void;
}

/**
 * Registers a suite's cases as tests of a test runner, so a provider package
 * runs the suite with its own tests. A skipped case passes; the runner shows
 * nothing more specific.
 *
 * @example
 * ```ts
 * import { describe, it } from "bun:test";
 * registerConformance(queueConformance, harness, { describe, it });
 * ```
 *
 * @param suite - The conformance cases of one contract.
 * @param harness - What the cases need, or a function that creates it per case.
 * @param runner - `describe` and `it` of the test runner.
 * @param timeoutMs - The time limit per case. Default 30 000.
 */
export function registerConformance<Harness>(suite: ConformanceSuite<Harness>, harness: Harness | (() => Harness | Promise<Harness>), runner: TestRunner, timeoutMs = 30_000): void {
  runner.describe(`${suite.contract} conformance`, () => {
    for (const entry of suite.cases) {
      runner.it(entry.name, async () => {
        const resolved = typeof harness === "function" ? await (harness as () => Harness | Promise<Harness>)() : harness;
        try {
          await entry.run(resolved);
        } catch (error) {
          if (!(error instanceof ConformanceSkip))
            throw error;
        }
      }, timeoutMs);
    }
  });
}

/**
 * Asserts a condition of a contract.
 *
 * @param contract - The contract being checked.
 * @param condition - What must hold.
 * @param message - What the provider did wrong when it does not.
 * @throws {ConformanceFailure} When the condition is false.
 */
export function expectThat(contract: string, condition: boolean, message: string): asserts condition {
  if (!condition)
    throw new ConformanceFailure(contract, message);
}

/**
 * Asserts that two JSON-like values are equal, comparing by structure.
 *
 * @param contract - The contract being checked.
 * @param actual - What the provider produced.
 * @param expected - What the contract requires.
 * @param what - What is compared, for the message.
 * @throws {ConformanceFailure} When the values differ.
 */
export function expectEqual(contract: string, actual: unknown, expected: unknown, what: string): void {
  if (!deepEqual(actual, expected))
    throw new ConformanceFailure(contract, `${what}: expected ${describe(expected)}, received ${describe(actual)}.`);
}

/**
 * Compares two values structurally: primitives by value, byte arrays by
 * content, arrays and plain objects member by member.
 *
 * @param left - One value.
 * @param right - The other value.
 * @returns `true` when they are equal.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right))
    return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array)
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  if (typeof left === "object" && typeof right === "object" && left !== null && right !== null && !Array.isArray(left) && !Array.isArray(right)) {
    const leftKeys = Object.keys(left).filter(key => (left as Record<string, unknown>)[key] !== undefined).sort();
    const rightKeys = Object.keys(right).filter(key => (right as Record<string, unknown>)[key] !== undefined).sort();
    return deepEqual(leftKeys, rightKeys) && leftKeys.every(key => deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}

/**
 * Renders a value for a failure message.
 *
 * @param value - The value to describe.
 * @returns A short JSON-like description.
 */
function describe(value: unknown): string {
  if (value instanceof Uint8Array)
    return `${value.length} bytes`;
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Waits until a probe returns a value, letting harness time pass between
 * attempts, up to a deadline.
 *
 * @param time - The harness time.
 * @param patienceMs - The most time to let pass.
 * @param probe - Returns the value, or `undefined` while it is not there yet.
 * @param stepMs - How much time passes between attempts. Default 100.
 * @returns The value, or `undefined` when the deadline passed.
 */
export async function eventually<Value>(time: ConformanceTime, patienceMs: number, probe: () => Promise<Value | undefined>, stepMs = 100): Promise<Value | undefined> {
  for (let waited = 0; ; waited += stepMs) {
    const value = await probe();
    if (value !== undefined)
      return value;
    if (waited >= patienceMs)
      return undefined;
    await time.advance(stepMs);
  }
}