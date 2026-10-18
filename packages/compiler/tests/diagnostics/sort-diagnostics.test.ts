import type { Diagnostic } from "@holqa/core";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  hasErrors,
  sortDiagnostics
} from "@/diagnostics/sort-diagnostics";

/**
 * Builds a diagnostic for ordering tests.
 *
 * @param code - Any registered diagnostic code.
 * @param file - The location file, or `undefined` for no location.
 * @param line - The location line.
 * @returns The diagnostic.
 */
function at(code: Diagnostic["code"], file?: string, line?: number): Diagnostic {
  return { code, severity: "warning", message: code, ...(file === undefined ? {} : { location: { file, ...(line === undefined ? {} : { line }) } }) };
}

describe("sortDiagnostics", () => {
  it("orders by file, line, column, code and message", () => {
    const sorted = sortDiagnostics([at("HOLQA_ROUTE_CONFLICT", "b.ts"), at("HOLQA_APP_INVALID", "a.ts", 9), at("HOLQA_APP_INVALID", "a.ts", 2), at("HOLQA_ANALYSIS_FAILED")]);
    expect(sorted.map(diagnostic => [diagnostic.location?.file, diagnostic.location?.line])).toEqual([[undefined, undefined], ["a.ts", 2], ["a.ts", 9], ["b.ts", undefined]]);
  });

  it("detects errors", () => {
    expect(hasErrors([at("HOLQA_APP_INVALID")])).toBe(false);
    expect(hasErrors([{ ...at("HOLQA_APP_INVALID"), severity: "error" }])).toBe(true);
  });
});