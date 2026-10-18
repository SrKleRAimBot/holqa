import type { DiagnosticLocation } from "@holqa/core";

import { compareCodeUnits } from "@/discovery/module-path";

/**
 * Finds where an identifier is written in source text, so that diagnostics
 * about evaluated descriptors can point at a line and column. This is a
 * best-effort static index: it looks for the identifier as a quoted string
 * literal and never affects what the compiler accepts or records.
 */
export class SourceLocator {
  /** Source texts by portable path, searched in the order of {@link SourceLocator.order}. */
  private readonly order: readonly string[];

  /**
   * Creates a locator over the given sources.
   *
   * @param sources - Source texts keyed by portable, root-relative path.
   * @param preferred - A path searched before all others, typically the application module.
   */
  constructor(private readonly sources: Readonly<Record<string, string>>, preferred: string) {
    const others = Object.keys(sources).filter(path => path !== preferred).sort(compareCodeUnits);
    this.order = Object.hasOwn(sources, preferred) ? [preferred, ...others] : others;
  }

  /**
   * Locates the first string literal equal to `value`.
   *
   * @param value - The identifier to find, for example `orders.process`.
   * @param fallback - The file to report when the literal is not found.
   * @param within - When given, search only this file.
   * @returns A location with 1-based line and column, or `{ file: fallback }`.
   */
  locate(value: string, fallback: string, within?: string): DiagnosticLocation {
    const expression = new RegExp(`(["'\`])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`);
    for (const path of within === undefined ? this.order : [within]) {
      const text = this.sources[path];
      if (text === undefined)
        continue;
      const match = expression.exec(text);
      if (match === null)
        continue;
      const before = text.slice(0, match.index);
      const line = before.split("\n").length;
      const column = match.index - before.lastIndexOf("\n");
      return { file: path, line, column };
    }
    return { file: fallback };
  }
}