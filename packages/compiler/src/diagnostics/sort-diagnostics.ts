import type { Diagnostic } from "@holqa/core";

/**
 * Orders diagnostics deterministically: by file (diagnostics without a
 * location first), line, column, code, then message.
 *
 * @param diagnostics - Diagnostics in collection order.
 * @returns A new, sorted array.
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const a = sortKey(left);
    const b = sortKey(right);
    for (let index = 0; index < a.length; index++) {
      if (a[index] !== b[index])
        return a[index]! < b[index]! ? -1 : 1;
    }
    return 0;
  });
}

/**
 * Lists the fields diagnostics are ordered by, most significant first.
 *
 * @param diagnostic - The diagnostic to derive the ordering key from.
 * @returns File, line, column, code and message.
 */
function sortKey(diagnostic: Diagnostic): readonly (string | number)[] {
  return [diagnostic.location?.file ?? "", diagnostic.location?.line ?? 0, diagnostic.location?.column ?? 0, diagnostic.code, diagnostic.message];
}

/**
 * Reports whether any diagnostic has severity `error`.
 *
 * @param diagnostics - The diagnostics to inspect.
 * @returns `true` when at least one is an error.
 */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.severity === "error");
}