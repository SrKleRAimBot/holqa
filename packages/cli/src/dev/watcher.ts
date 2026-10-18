import { watch } from "node:fs";
import { sep } from "node:path";

/** File extensions whose changes can change the application. */
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** Environment files Bun loads for the application. */
const environmentFile = /^\.env(?:\..+)?$/;

/**
 * Reports whether a file is an environment file that Bun loads for the
 * application (`.env`, `.env.local`, ...) in the application root.
 *
 * @param path - A path relative to the application root, with `/` separators.
 * @returns `true` for `.env` files directly in the root.
 */
export function isEnvironmentFile(path: string): boolean {
  return !path.includes("/") && environmentFile.test(path);
}

/**
 * Reports whether a change to a file can change the running application:
 * sources and JSON files outside `node_modules` and dot directories (such as
 * `.git` and `.holqa`, which holds the build and the local state), and
 * environment files in the root. Everything else, such as documentation, is
 * ignored.
 *
 * @param path - A path relative to the application root, with `/` separators.
 * @returns `true` when the change should trigger a rebuild.
 */
export function isWatchedFile(path: string): boolean {
  if (path === "")
    return false;
  if (isEnvironmentFile(path))
    return true;
  const segments = path.split("/");
  if (segments.some(segment => segment === "node_modules" || segment.startsWith(".")))
    return false;
  return sourceExtensions.some(extension => path.endsWith(extension));
}

/** Settings of {@link watchFiles}. */
export interface WatchFilesOptions {
  /** The directory to watch, recursively. */
  readonly root: string;
  /** Receives the changed files (relative, `/`-separated, sorted) once changes stop arriving for `debounceMs`. */
  readonly onChange: (files: readonly string[]) => void;
  /** Receives watcher failures, for example when the system's watch limit is reached. */
  readonly onError?: (error: unknown) => void;
  /** How long to wait for further changes before reporting. Default 100 ms. */
  readonly debounceMs?: number;
}

/**
 * Watches a directory tree for changes that can affect the application and
 * reports them in batches, so that saving several files (or an editor writing
 * a file in several steps) causes one rebuild.
 *
 * Uses `fs.watch` with `recursive: true`, which Bun 1.3 supports on macOS and
 * Linux. Events can be coalesced or duplicated by the operating system; the
 * batch is a set of paths, and a rebuild re-reads everything anyway.
 *
 * @param options - The directory, callbacks and debounce period.
 * @returns A function that stops watching and drops pending changes.
 */
export function watchFiles(options: WatchFilesOptions): () => void {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Reports the pending batch. */
  const flush = (): void => {
    timer = undefined;
    const files = [...pending].sort();
    pending.clear();
    if (files.length > 0)
      options.onChange(files);
  };
  const watcher = watch(options.root, { recursive: true }, (_event, file) => {
    if (typeof file !== "string")
      return;
    const path = file.split(sep).join("/");
    if (!isWatchedFile(path))
      return;
    pending.add(path);
    clearTimeout(timer);
    timer = setTimeout(flush, options.debounceMs ?? 100);
  });
  watcher.on("error", error => options.onError?.(error));
  return () => {
    clearTimeout(timer);
    pending.clear();
    watcher.close();
  };
}