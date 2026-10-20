import type {
  ConformanceResult,
  ConformanceSuite
} from "@/suite";

import { ConformanceSkip } from "@/suite";

/** The format tag of a provider test report. */
export const providerTestReportFormat = "holqa.provider-tests/1";

/**
 * One suite to run against one provider.
 *
 * @typeParam Harness - What the suite's cases need.
 */
export interface ProviderTestEntry<Harness> {
  /** A name for the report, for example `rabbitmq queues`. */
  readonly name: string;
  readonly suite: ConformanceSuite<Harness>;
  /** The harness, or a function that creates a fresh one for each case (recommended: cases must not share state). */
  readonly harness: Harness | (() => Harness | Promise<Harness>);
}

/** A suite paired with its harness, with the harness type checked when it was created by {@link providerTest}. */
export type AnyProviderTestEntry = ProviderTestEntry<unknown>;

/** The provider tests of a module, for `holqa providers test`. */
export interface ProviderTests {
  readonly type: "holqa.provider-tests";
  readonly entries: readonly AnyProviderTestEntry[];
}

/**
 * Pairs a suite with a harness for {@link defineProviderTests}; the harness
 * must have the type the suite needs.
 *
 * @param name - A name for the report, for example `rabbitmq queues`.
 * @param suite - The conformance suite.
 * @param harness - The harness, or a function that creates a fresh one per case.
 * @returns The entry.
 */
export function providerTest<Harness>(name: string, suite: ConformanceSuite<Harness>, harness: Harness | (() => Harness | Promise<Harness>)): AnyProviderTestEntry {
  // The pairing is checked here; afterwards the harness type no longer matters to the runner.
  return Object.freeze({ name, suite, harness }) as unknown as AnyProviderTestEntry;
}

/** The outcome of running provider tests. */
export interface ProviderTestReport {
  readonly format: typeof providerTestReportFormat;
  readonly suites: readonly { readonly name: string; readonly contract: string; readonly results: readonly ConformanceResult[] }[];
  readonly summary: { readonly passed: number; readonly failed: number; readonly skipped: number };
}

/**
 * Declares which conformance suites to run against which providers, as the
 * default export of a module `holqa providers test` runs, conventionally
 * `conformance.ts` next to the application module. Each entry pairs a suite
 * with a harness for the provider under test.
 *
 * @example
 * ```ts
 * export default defineProviderTests([providerTest("rabbitmq queues", queueConformance, () => rabbitHarness())]);
 * ```
 *
 * @param entries - The suites with their harnesses, created with {@link providerTest}.
 * @returns The frozen provider tests.
 * @throws {TypeError} When an entry has no name, suite or harness.
 */
export function defineProviderTests(entries: readonly AnyProviderTestEntry[]): ProviderTests {
  for (const [index, entry] of entries.entries()) {
    if (typeof entry?.name !== "string" || entry.name === "" || typeof entry.suite?.contract !== "string" || !Array.isArray(entry.suite.cases) || entry.harness === undefined)
      throw new TypeError(`defineProviderTests: entry ${index} needs a name, a conformance suite and a harness.`);
  }
  return Object.freeze({ type: "holqa.provider-tests", entries: Object.freeze([...entries]) });
}

/**
 * Reports whether a value was created by {@link defineProviderTests}.
 *
 * @param value - The candidate, for example a module's default export.
 * @returns `true` for provider tests.
 */
export function isProviderTests(value: unknown): value is ProviderTests {
  return typeof value === "object" && value !== null && (value as { readonly type?: unknown }).type === "holqa.provider-tests" && Array.isArray((value as { readonly entries?: unknown }).entries);
}

/**
 * Runs provider tests: every case of every selected suite, one after another,
 * each with a fresh harness when the entry creates one, and a time limit per
 * case. A case that throws `ConformanceSkip` is skipped; any other error, or
 * running out of time, fails it.
 *
 * @param tests - Suites paired with harnesses, from defineProviderTests.
 * @param options - Which entries to run, by name, and the time limit per case.
 * @param options.only - Entry names to run; all when absent.
 * @param options.timeoutMs - The time limit per case. Default 30 000.
 * @returns The report.
 */
export async function runProviderTests(tests: ProviderTests, options: { readonly only?: readonly string[]; readonly timeoutMs?: number } = {}): Promise<ProviderTestReport> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const suites: Array<ProviderTestReport["suites"][number]> = [];
  for (const entry of tests.entries) {
    if (options.only !== undefined && !options.only.includes(entry.name))
      continue;
    const results: ConformanceResult[] = [];
    for (const testCase of entry.suite.cases) {
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            const harness = typeof entry.harness === "function" ? await (entry.harness as () => unknown)() : entry.harness;
            await (testCase.run as (harness: unknown) => Promise<void>)(harness);
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`The case did not finish within ${timeoutMs} ms.`)), timeoutMs);
          })
        ]);
        results.push({ contract: entry.suite.contract, name: testCase.name, status: "passed", durationMs: performance.now() - started });
      } catch (error) {
        const skipped = error instanceof ConformanceSkip;
        results.push({ contract: entry.suite.contract, name: testCase.name, status: skipped ? "skipped" : "failed", message: error instanceof Error ? error.message : String(error), durationMs: performance.now() - started });
      } finally {
        clearTimeout(timer);
      }
    }
    suites.push({ name: entry.name, contract: entry.suite.contract, results });
  }
  const all = suites.flatMap(suite => suite.results);
  return {
    format: providerTestReportFormat,
    suites,
    summary: { passed: all.filter(result => result.status === "passed").length, failed: all.filter(result => result.status === "failed").length, skipped: all.filter(result => result.status === "skipped").length }
  };
}