import type {
  AnalysisOutcome,
  AnalysisSuccess
} from "@/analysis/host";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

describe("AnalysisOutcome", () => {
  it("exposes the manifest only on success", () => {
    /**
     * Reads the manifest after checking the outcome.
     *
     * @param outcome - An analysis outcome.
     * @returns The manifest of a successful analysis.
     */
    const read = (outcome: AnalysisOutcome): AnalysisSuccess["manifest"] | undefined => outcome.ok ? outcome.manifest : undefined;
    expectTypeOf(read).returns.toEqualTypeOf<AnalysisSuccess["manifest"] | undefined>();
    /**
     * Reads the manifest without checking the outcome, which must not compile.
     *
     * @param outcome - An analysis outcome.
     * @returns Nothing usable.
     */
    // @ts-expect-error `manifest` does not exist until `ok` is checked.
    const unchecked = (outcome: AnalysisOutcome): unknown => outcome.manifest;
    expect(typeof unchecked).toBe("function");
  });
});