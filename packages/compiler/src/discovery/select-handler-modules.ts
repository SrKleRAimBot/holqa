import type {
  Diagnostic,
  HandlerDiscovery
} from "@holqa/core";

import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

import { compileGlob } from "@/discovery/glob";
import {
  compareCodeUnits,
  portableModulePath
} from "@/discovery/module-path";

/** The modules a host must evaluate, and the problems found while selecting them. */
export interface HandlerModuleSelection {
  /** Portable, root-relative module paths, sorted and unique. */
  readonly modules: readonly string[];
  /**
   * `HOLQA_HANDLER_PATTERN_UNMATCHED` warnings for include patterns that matched
   * nothing, and `HOLQA_DECLARATION_INVALID` errors for patterns or file paths
   * that are not relative to the application root.
   */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Selects handler modules from the files a host found under the application
 * root, using the application's `handlers` patterns. The selection depends
 * only on the inputs: listing order, absolute paths and the host's own glob
 * implementation never change it.
 *
 * File names only locate modules. They are never identities: a handler is
 * identified by the `id` in its registration wherever its module lives.
 *
 * @param files - Root-relative file paths, in any order, with `/` or `\\` separators.
 * @param discovery - The application's include and exclude patterns.
 * @param appModule - The root-relative path of the application module, used as the location of pattern diagnostics.
 * @returns The sorted module paths and diagnostics.
 */
export function selectHandlerModules(files: readonly string[], discovery: HandlerDiscovery, appModule: string): HandlerModuleSelection {
  const diagnostics: Diagnostic[] = [];
  const location = { file: appModule };
  const portable: string[] = [];
  for (const file of files) {
    const path = portableModulePath(file);
    if (path === undefined) {
      diagnostics.push(createDiagnostic({
        code: diagnosticCodes.declarationInvalid,
        severity: "error",
        message: `The file path "${file}" is not relative to the application root.`,
        hint: "Hosts must pass root-relative paths so that output never depends on the machine."
      }));
    } else {
      portable.push(path);
    }
  }

  const include = patterns(discovery.include, "handlers.include", diagnostics, location);
  const exclude = patterns(discovery.exclude, "handlers.exclude", diagnostics, location);
  const selected = new Set<string>();
  for (const matcher of include) {
    const matched = portable.filter(path => matcher.matches(path));
    if (matched.length === 0) {
      diagnostics.push(createDiagnostic({
        code: diagnosticCodes.handlerPatternUnmatched,
        severity: "warning",
        message: `The handler pattern "${matcher.pattern}" matches no module.`,
        location,
        hint: "Patterns are relative to the directory of the application module. Fix or remove the pattern.",
        details: { pattern: matcher.pattern }
      }));
    }
    for (const path of matched)
      selected.add(path);
  }
  const modules = [...selected]
    .filter(path => !exclude.some(matcher => matcher.matches(path)))
    .sort(compareCodeUnits);
  return { modules, diagnostics };
}

/**
 * Compiles a list of patterns, rejecting those that would escape the application root.
 *
 * @param values - Glob patterns from the application's handler discovery settings.
 * @param option - The option name, for messages.
 * @param diagnostics - Receives a diagnostic per rejected pattern.
 * @param location - The location of the application module.
 * @param location.file - The application module's root-relative path.
 * @returns Matchers for the accepted patterns, in the given order.
 */
function patterns(values: readonly string[], option: string, diagnostics: Diagnostic[], location: { readonly file: string }): ReturnType<typeof compileGlob>[] {
  const matchers: ReturnType<typeof compileGlob>[] = [];
  for (const value of values) {
    if (typeof value !== "string" || portableModulePath(value.replaceAll("*", "x")) === undefined) {
      diagnostics.push(createDiagnostic({
        code: diagnosticCodes.declarationInvalid,
        severity: "error",
        message: `The ${option} pattern "${String(value)}" must be relative to the application and must not contain "..".`,
        location
      }));
      continue;
    }
    matchers.push(compileGlob(value));
  }
  return matchers;
}