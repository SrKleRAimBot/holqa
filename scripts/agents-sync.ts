/**
 * Synchronizes shared agent instructions from `.agents/` (canonical) into the
 * Claude Code mirror under `.claude/`, or verifies that the mirror is current.
 *
 * Usage:
 *   bun scripts/agents-sync.ts --write   Copy canonical files and delete stale mirror files.
 *   bun scripts/agents-sync.ts --check   Exit non-zero if the mirror has drifted.
 *
 * Only the directories listed in `mirroredDirectories` are mirrored. Claude-only
 * files (for example `.claude/agents/` and `.claude/settings.json`) live outside
 * that subset and are never touched. Files are copied byte-for-byte rather than
 * symlinked so that the mirror works on every platform and in every tool.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  dirname,
  join,
  relative,
  sep
} from "node:path";

/** Repository root, resolved from this script's location. */
const root = join(import.meta.dir, "..");

/** Canonical directory for agent instructions shared by every agent tool. */
const sourceRoot = join(root, ".agents");

/** Claude Code-compatible mirror of the shared subset. */
const mirrorRoot = join(root, ".claude");

/** Subdirectories of `.agents/` that are mirrored into `.claude/`. */
const mirroredDirectories = ["rules", "skills"] as const;

/** A single difference between the canonical tree and the mirror. */
type Drift
  = | { readonly kind: "missing"; readonly path: string }
    | { readonly kind: "changed"; readonly path: string }
    | { readonly kind: "stale"; readonly path: string };

/**
 * Lists every file below `directory`, as paths relative to `base` using `/` separators.
 *
 * @param directory - The directory to walk. A missing directory yields no files.
 * @param base - The directory that returned paths are relative to.
 * @returns Sorted relative file paths.
 */
function listFiles(directory: string, base: string): string[] {
  if (!existsSync(directory))
    return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...listFiles(path, base));
    else if (entry.isFile())
      files.push(relative(base, path).split(sep).join("/"));
  }
  return files.sort();
}

/**
 * Compares the canonical `.agents/` subset with its `.claude/` mirror.
 *
 * @returns Every missing, changed or stale mirror file, in a stable order.
 */
function findDrift(): Drift[] {
  const drift: Drift[] = [];
  for (const directory of mirroredDirectories) {
    const sourceFiles = listFiles(join(sourceRoot, directory), sourceRoot);
    const mirrorFiles = new Set(listFiles(join(mirrorRoot, directory), mirrorRoot));

    for (const path of sourceFiles) {
      if (!mirrorFiles.has(path))
        drift.push({ kind: "missing", path });
      else if (!readFileSync(join(sourceRoot, path)).equals(readFileSync(join(mirrorRoot, path))))
        drift.push({ kind: "changed", path });
      mirrorFiles.delete(path);
    }
    for (const path of mirrorFiles)
      drift.push({ kind: "stale", path });
  }
  return drift;
}

/**
 * Brings the mirror in line with the canonical tree by copying missing or
 * changed files and deleting stale ones.
 *
 * @param drift - The differences reported by {@link findDrift}.
 */
function applySync(drift: readonly Drift[]): void {
  for (const item of drift) {
    const target = join(mirrorRoot, item.path);
    if (item.kind === "stale") {
      rmSync(target);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(sourceRoot, item.path)));
  }
}

/**
 * Verifies that `CLAUDE.md` imports `AGENTS.md`, which keeps the two root
 * instruction files from diverging.
 *
 * @returns A problem description, or `undefined` when the import is present.
 */
function checkRootInstructions(): string | undefined {
  const claude = join(root, "CLAUDE.md");
  if (!existsSync(join(root, "AGENTS.md")))
    return "AGENTS.md is missing.";
  if (!existsSync(claude))
    return "CLAUDE.md is missing.";
  return readFileSync(claude, "utf8").split("\n").some(line => line.trim() === "@AGENTS.md")
    ? undefined
    : "CLAUDE.md must import the shared instructions with a line containing exactly \"@AGENTS.md\".";
}

/**
 * Parses the command line, runs the requested mode and sets the exit code.
 */
function main(): void {
  const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : undefined;
  if (mode === undefined) {
    console.error("Usage: bun scripts/agents-sync.ts --write | --check");
    process.exitCode = 2;
    return;
  }

  const drift = findDrift();
  const rootProblem = checkRootInstructions();

  if (mode === "write") {
    applySync(drift);
    console.log(drift.length === 0 ? "Agent mirror already up to date." : `Synchronized ${drift.length} file(s) into .claude/.`);
  } else if (drift.length > 0) {
    for (const item of drift)
      console.error(`${item.kind.padEnd(7)} .claude/${item.path}`);
    console.error(`\n${drift.length} file(s) in .claude/ differ from .agents/. Run "pnpm agents:sync" and commit the result.`);
    process.exitCode = 1;
  } else {
    console.log(`Agent mirror is in sync (${mirroredDirectories.map(directory => `${directory}/`).join(", ")}).`);
  }

  if (rootProblem !== undefined) {
    console.error(rootProblem);
    process.exitCode = 1;
  }
}

main();