import type { Result } from "@holqa/core";
import type { AppDescriptor } from "@holqa/experiment-model";

import type { RuntimeDiagnostic } from "@/diagnostics";

import {
  err,
  ok
} from "@holqa/core";
import {
  errorCode,
  experimentCodes,
  getAppDescriptor
} from "@holqa/experiment-model";

import {
  describeError,
  runtimeError
} from "@/diagnostics";

/** One evaluated handler module. */
export interface LoadedModule {
  /** Path relative to the application root, with `/` separators. */
  readonly path: string;
  readonly exports: Readonly<Record<string, unknown>>;
}

/** The evaluated module graph of one generation. */
export interface LoadedGraph {
  readonly app: AppDescriptor;
  readonly modules: readonly LoadedModule[];
}

/**
 * Joins a root directory and a relative path with `/` separators.
 *
 * @param root - An absolute directory.
 * @param path - A path relative to `root`.
 * @returns The absolute path.
 */
export function joinPath(root: string, path: string): string {
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
}

/**
 * Finds the handler modules matched by an application's globs.
 *
 * @param root - The application root (the directory of `infra.ts`).
 * @param patterns - Glob patterns relative to `root`.
 * @returns Matching file paths relative to `root`, de-duplicated and sorted so that load order is deterministic.
 */
export async function discoverHandlerModules(root: string, patterns: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of patterns) {
    for await (const file of new Bun.Glob(pattern.replace(/^\.\//, "")).scan({ cwd: root, onlyFiles: true }))
      files.add(file.split("\\").join("/"));
  }
  return [...files].sort();
}

/**
 * Removes every module under `root` (excluding `node_modules`) from Bun's
 * module cache, so that the next `import()` evaluates a fresh module graph.
 *
 * Bun 1.3.13 honours `delete require.cache[path]` for ES modules too, which
 * the official documentation only states for CommonJS (`require.cache` is
 * listed as "fully implemented" Node compatibility). Modules already evaluated
 * keep working through existing references. Treat this as an observed, not a
 * guaranteed, behaviour.
 *
 * @param root - The application root.
 * @returns The number of evicted cache entries.
 */
export function evictModuleCache(root: string): number {
  const prefix = `${root.replace(/\/+$/, "")}/`;
  let evicted = 0;
  for (const path of Object.keys(require.cache)) {
    if (path.startsWith(prefix) && !path.includes("/node_modules/")) {
      delete require.cache[path];
      evicted += 1;
    }
  }
  return evicted;
}

/**
 * Imports one module, failing instead of hanging when the import never settles.
 *
 * Bun 1.3.13 never settles a repeated `import()` of a specifier whose earlier
 * evaluation failed to parse, even after the file is fixed and evicted, so a
 * timeout keeps one broken edit from blocking every later reload.
 *
 * @param specifier - The absolute module specifier.
 * @param timeoutMs - How long to wait.
 * @returns The module namespace.
 * @throws {Error} The import's own error, or a timeout error.
 */
async function importWithTimeout(specifier: string, timeoutMs: number): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Import did not settle within ${String(timeoutMs)} ms; Bun may have cached an earlier failure of this module. Restart the process.`)), timeoutMs);
  });
  try {
    return await Promise.race([import(specifier) as Promise<Record<string, unknown>>, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Options accepted by {@link importGraph}. */
export interface ImportGraphOptions {
  /**
   * A query string appended to handler module specifiers, for example
   * `holqa-generation=3`. It forces Bun to evaluate those modules again even if
   * an earlier evaluation failed. It does not affect the registry or modules
   * the handlers import.
   */
  readonly cacheBust?: string;
  /** How long one module import may take. Defaults to 10 000 ms. */
  readonly timeoutMs?: number;
}

/**
 * Imports an application's `infra.ts` and every handler module its globs
 * match. Every module that throws is reported, not just the first.
 *
 * @param root - The application root.
 * @param entry - The registry file relative to `root`, normally `infra.ts`.
 * @param options - Cache-busting query and import timeout.
 * @returns The evaluated graph, or `HOLQA_MODULE_EVALUATION_FAILED` / `HOLQA_DECLARATION_INVALID` diagnostics.
 */
export async function importGraph(root: string, entry: string, options: ImportGraphOptions = {}): Promise<Result<LoadedGraph, RuntimeDiagnostic[]>> {
  const suffix = options.cacheBust === undefined ? "" : `?${options.cacheBust}`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let infra: Record<string, unknown>;
  try {
    // Never cache-bust the registry: handlers import it by its plain path, and a
    // second instance would hold a different, unbound application.
    infra = await importWithTimeout(joinPath(root, entry), timeoutMs);
  } catch (error) {
    return err([runtimeError(experimentCodes.moduleEvaluationFailed, `Evaluating ${entry} failed: ${describeError(error)}`, { file: entry })]);
  }

  const { default: appExport } = infra;
  const app = getAppDescriptor(appExport);
  if (app === undefined)
    return err([runtimeError(experimentCodes.declarationInvalid, `${entry} must default-export the result of defineApp(...).`, { file: entry })]);

  const diagnostics: RuntimeDiagnostic[] = [];
  const modules: LoadedModule[] = [];
  for (const path of await discoverHandlerModules(root, app.handlers)) {
    try {
      modules.push({ path, exports: await importWithTimeout(`${joinPath(root, path)}${suffix}`, timeoutMs) });
    } catch (error) {
      diagnostics.push(runtimeError(experimentCodes.moduleEvaluationFailed, `Evaluating ${path} failed: ${describeError(error)}`, {
        file: path,
        ...(errorCode(error) === experimentCodes.runtimeNotBound ? { hint: "Handler modules must not use resource handles or configuration at module top level; read them inside the handler." } : {})
      }));
    }
  }
  return diagnostics.length > 0 ? err(diagnostics) : ok({ app, modules });
}

/**
 * Parses every source file under the application root (excluding
 * `node_modules`) without evaluating it. Used before in-process loads: a file
 * that fails to parse during `import()` permanently poisons Bun's module
 * registry for that path, so syntax errors must be caught before importing.
 *
 * @param root - The application root.
 * @returns One `HOLQA_MODULE_EVALUATION_FAILED` diagnostic per file that does not parse.
 */
export async function checkSyntax(root: string): Promise<RuntimeDiagnostic[]> {
  const diagnostics: RuntimeDiagnostic[] = [];
  for await (const file of new Bun.Glob("**/*.{ts,tsx,mts,cts,js,mjs,cjs,jsx}").scan({ cwd: root, onlyFiles: true })) {
    const path = file.split("\\").join("/");
    if (path.split("/").includes("node_modules"))
      continue;
    const loader = path.endsWith("x") ? "tsx" : path.endsWith("js") ? "js" : "ts";
    try {
      new Bun.Transpiler({ loader }).transformSync(await Bun.file(joinPath(root, path)).text());
    } catch (error) {
      diagnostics.push(runtimeError(experimentCodes.moduleEvaluationFailed, `${path} does not parse: ${describeError(error)}`, { file: path }));
    }
  }
  return diagnostics.sort((left, right) => (left.location?.file ?? "").localeCompare(right.location?.file ?? ""));
}