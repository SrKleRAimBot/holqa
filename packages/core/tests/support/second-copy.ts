import type * as Core from "@/index";

import {
  cpSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  join
} from "node:path";

/** A separately loaded copy of `@holqa/core` and a function that deletes its files. */
export interface SecondCopy {
  readonly core: typeof Core;
  readonly dispose: () => void;
}

/**
 * Loads a second, independent instance of this package's source, the way an
 * installation with two copies of `@holqa/core` would. The sources are copied
 * to a temporary directory with their own path aliases, so every module,
 * class and function in the copy is distinct from the one under test.
 *
 * @returns The second copy and a cleanup function.
 */
export async function loadSecondCopy(): Promise<SecondCopy> {
  const root = mkdtempSync(join(tmpdir(), "holqa-core-copy-"));
  cpSync(dirname(Bun.fileURLToPath(import.meta.resolve("@/index"))), join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }));
  const core = await import(join(root, "src", "index.ts")) as typeof Core;
  return { core, dispose: () => rmSync(root, { recursive: true, force: true }) };
}