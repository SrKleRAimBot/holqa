import {
  readFileSync,
  realpathSync
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  sep
} from "node:path";

/** The comment that marks a module whose changes always restart the application process. */
export const restartMarker = "holqa:restart-on-change";

/** The loaders `Bun.Transpiler` uses for each source extension. */
const loaders: Readonly<Record<string, "ts" | "tsx" | "js" | "jsx">> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx"
};

/**
 * The static import graph of an application's own modules: every source
 * file under the application root (outside `node_modules`) reachable from
 * the given entry modules. Imports that resolve to packages or to files
 * outside the root are leaves: they are not application code that `holqa
 * dev` watches or replaces.
 */
export interface ModuleGraph {
  /** The application root, as a real path. */
  readonly root: string;
  /** The application modules each module imports, by absolute real path. */
  readonly imports: ReadonlyMap<string, ReadonlySet<string>>;
  /** Modules whose source contains {@link restartMarker}. */
  readonly marked: ReadonlySet<string>;
  /** Modules whose imports could not all be read, for example after a file was removed. */
  readonly unreadable: ReadonlySet<string>;
}

/**
 * Reports whether a path is an application module: inside the root and not in `node_modules`.
 *
 * @param root - The application root, as a real path.
 * @param path - An absolute real path.
 * @returns `true` for application modules.
 */
function isApplicationModule(root: string, path: string): boolean {
  const from = relative(root, path);
  return from !== "" && !from.startsWith("..") && !isAbsolute(from) && !from.split(sep).includes("node_modules");
}

/**
 * Resolves a path to its real path, keeping it when it does not exist.
 *
 * @param path - An absolute path.
 * @returns The real path.
 */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A file that does not exist (any more) keeps its path; the analysis reports the missing import.
    return path;
  }
}

/**
 * Builds the import graph of the application modules reachable from entry modules.
 * Static imports, re-exports, `require` calls and dynamic imports with literal
 * specifiers are followed; dynamic imports with computed specifiers cannot be.
 *
 * @param root - The application root.
 * @param entries - Absolute paths of the entry modules (the application module and the handler modules).
 * @returns The imports of every reachable application module.
 */
export function buildModuleGraph(root: string, entries: readonly string[]): ModuleGraph {
  const realRoot = real(root);
  const imports = new Map<string, Set<string>>();
  const marked = new Set<string>();
  const unreadable = new Set<string>();
  const pending = entries.map(real);
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (imports.has(file))
      continue;
    const targets = new Set<string>();
    imports.set(file, targets);
    const loader = loaders[extname(file)];
    if (loader === undefined)
      continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      unreadable.add(file);
      continue;
    }
    if (source.includes(restartMarker))
      marked.add(file);
    let specifiers: readonly string[];
    try {
      specifiers = new Bun.Transpiler({ loader }).scanImports(source).map(entry => entry.path);
    } catch {
      // A syntax error: the analysis reports it; the graph only lacks this module's imports.
      unreadable.add(file);
      continue;
    }
    for (const specifier of specifiers) {
      let resolved: string;
      try {
        resolved = Bun.resolveSync(specifier, dirname(file));
      } catch {
        continue;
      }
      if (!isAbsolute(resolved))
        continue;
      const target = real(resolved);
      if (!isApplicationModule(realRoot, target))
        continue;
      targets.add(target);
      pending.push(target);
    }
  }
  return { root: realRoot, imports, marked, unreadable };
}

/**
 * Lists the modules reachable from a module, the module included.
 *
 * @param graph - The import graph.
 * @param start - An absolute real path.
 * @param stop - Modules not to enter (they are not included either).
 * @returns The reachable modules.
 */
export function reachable(graph: ModuleGraph, start: string, stop: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file) || stop.has(file))
      continue;
    seen.add(file);
    for (const target of graph.imports.get(file) ?? [])
      pending.push(target);
  }
  return seen;
}