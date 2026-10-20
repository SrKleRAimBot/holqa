import type { ConformanceSuite } from "@/suite";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  defineProviderTests,
  isProviderTests,
  providerTest,
  runProviderTests
} from "@/provider-tests";
import {
  ConformanceFailure,
  ConformanceSkip
} from "@/suite";

/** A suite whose cases pass, fail, skip and hang, against a counter harness. */
const suite: ConformanceSuite<{ readonly id: number }> = {
  contract: "example",
  cases: [
    { name: "passes", run: async () => {} },
    { name: "fails", run: async () => {
      throw new ConformanceFailure("example", "broken");
    } },
    { name: "skips", run: async () => {
      throw new ConformanceSkip("not applicable");
    } },
    { name: "hangs", run: () => new Promise(() => {}) }
  ]
};

describe("provider tests", () => {
  it("runs every case with a fresh harness and summarizes outcomes, failing cases that run out of time", async () => {
    let harnesses = 0;
    const tests = defineProviderTests([providerTest("example provider", suite, () => ({ id: ++harnesses }))]);
    expect(isProviderTests(tests)).toBe(true);
    const report = await runProviderTests(tests, { timeoutMs: 50 });
    expect(report.format).toBe("holqa.provider-tests/1");
    expect(report.suites[0]!.results.map(result => [result.name, result.status])).toEqual([["passes", "passed"], ["fails", "failed"], ["skips", "skipped"], ["hangs", "failed"]]);
    expect(report.suites[0]!.results[3]!.message).toBe("The case did not finish within 50 ms.");
    expect(report.summary).toEqual({ passed: 1, failed: 2, skipped: 1 });
    expect(harnesses).toBe(4);
  });

  it("runs only the selected entries and rejects malformed ones", async () => {
    const tests = defineProviderTests([providerTest("a", suite, { id: 1 }), providerTest("b", suite, { id: 2 })]);
    expect((await runProviderTests(tests, { only: ["b"], timeoutMs: 10 })).suites.map(entry => entry.name)).toEqual(["b"]);
    expect(() => defineProviderTests([providerTest("", suite, { id: 3 })])).toThrow("needs a name");
    // @ts-expect-error The harness must have the type the suite needs.
    providerTest("typed", suite, { name: "not an id" });
  });
});