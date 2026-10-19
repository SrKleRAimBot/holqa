import {
  readdirSync,
  statSync,
  watch
} from "node:fs";
import {
  join,
  sep
} from "node:path";

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
 * Records the modification time and size of every watched file under a
 * directory, skipping the directories {@link isWatchedFile} ignores. Files
 * that disappear while it reads are left out.
 *
 * @param root - The directory to read.
 * @returns Each watched file (relative, `/`-separated) with its `mtime:size`.
 * @throws When a directory cannot be read for another reason than having been removed.
 */
export function snapshotFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  /**
   * Adds the watched files of one directory and its subdirectories.
   *
   * @param directory - The directory, relative to the root; `""` for the root.
   */
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error))
        return;
      throw error;
    }
    for (const entry of entries) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith("."))
          visit(path);
      } else if (entry.isFile() && isWatchedFile(path)) {
        try {
          const stats = statSync(join(root, path));
          files.set(path, `${stats.mtimeMs}:${stats.size}`);
        } catch (error) {
          if (!isMissing(error))
            throw error;
        }
      }
    }
  };
  visit("");
  return files;
}

/**
 * Reports whether a file system error means the file or directory no longer exists.
 *
 * @param error - What a file system call threw.
 * @returns `true` for `ENOENT` and `ENOTDIR`.
 */
function isMissing(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Lists the files that were added, removed or modified between two snapshots.
 *
 * @param before - The earlier snapshot.
 * @param after - The later snapshot.
 * @returns The differing paths.
 */
function changedFiles(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const changed = [...after].filter(([path, stamp]) => before.get(path) !== stamp).map(([path]) => path);
  return [...changed, ...[...before.keys()].filter(path => !after.has(path))];
}

/**
 * Watches a directory tree for changes that can affect the application and
 * reports them in batches, so that saving several files (or an editor writing
 * a file in several steps) causes one rebuild.
 *
 * Uses `fs.watch` with `recursive: true`, which Bun 1.3 supports on macOS and
 * Linux. File names in events are not reliable: the operating system can
 * coalesce or duplicate events, and Bun 1.3 on Linux reports only one file
 * when several files change at once. Any event therefore only starts the
 * debounce period; the batch is then the files whose modification time or
 * size changed since the previous batch (see {@link snapshotFiles}), plus the
 * watched files events named.
 *
 * @param options - The directory, callbacks and debounce period.
 * @returns A function that stops watching and drops pending changes.
 * @throws When the directory cannot be read.
 */
export function watchFiles(options: WatchFilesOptions): () => void {
  const pending = new Set<string>();
  let snapshot = snapshotFiles(options.root);
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Reports the files changed since the previous batch. */
  const flush = (): void => {
    timer = undefined;
    let next: Map<string, string>;
    try {
      next = snapshotFiles(options.root);
    } catch (error) {
      options.onError?.(error);
      return;
    }
    const files = [...new Set([...pending, ...changedFiles(snapshot, next)])].sort();
    snapshot = next;
    pending.clear();
    if (files.length > 0)
      options.onChange(files);
  };
  const watcher = watch(options.root, { recursive: true }, (_event, file) => {
    if (typeof file === "string") {
      const path = file.split(sep).join("/");
      if (isWatchedFile(path))
        pending.add(path);
    }
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