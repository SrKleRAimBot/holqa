import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  dirname,
  join
} from "node:path";

/** Scratch directory inside the package, so copied fixtures still resolve the package's node_modules. */
const scratch = join(import.meta.dir, "..", "..", ".tmp");
let copies = 0;

/**
 * Copies a fixture application to a fresh scratch directory.
 *
 * @param name - The fixture directory under `tests/fixtures/`.
 * @returns The absolute path of the copy.
 */
export function copyFixture(name: string): string {
  copies += 1;
  const target = join(scratch, `${name}-${String(process.pid)}-${String(copies)}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  cpSync(join(import.meta.dir, "..", "fixtures", name), target, { recursive: true });
  return target;
}

/**
 * Writes or replaces a file inside a copied fixture.
 *
 * @param root - The fixture copy.
 * @param path - The file path relative to `root`.
 * @param contents - The new contents.
 */
export function writeFixtureFile(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

/**
 * Sets the fixture's `version` constant, which handlers report.
 *
 * @param root - The fixture copy.
 * @param version - The new version string.
 */
export function setFixtureVersion(root: string, version: string): void {
  const path = join(root, "state.ts");
  writeFileSync(path, readFileSync(path, "utf8").replace(/export const version = "[^"]*";/, `export const version = "${version}";`));
}

/** Removes every scratch copy. */
export function removeFixtureCopies(): void {
  rmSync(scratch, { recursive: true, force: true });
}

/** Environment that satisfies the basic fixture's configuration. */
export const basicEnv = { TOKEN: "s3cr3t-token" } as const;