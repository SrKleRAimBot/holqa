import {
  readdirSync,
  readFileSync
} from "node:fs";
import { createRequire } from "node:module";
import {
  dirname,
  join
} from "node:path";
import {
  describe,
  expect,
  it
} from "bun:test";

const require = createRequire(import.meta.url);

/** Workspace packages whose build output is checked. */
const packages = ["@holqa/core", "@holqa/compiler", "@holqa/cli", "@holqa/local", "@holqa/runtime-bun", "@holqa/sdk", "@holqa/testing", "@holqa/zod"];

/**
 * Locates the `dist/` directory of an installed workspace package.
 *
 * @param name - The package name.
 * @returns The absolute path of the package's `dist/` directory.
 */
function distDirectory(name: string): string {
  return join(dirname(require.resolve(`${name}/package.json`)), "dist");
}

describe("published artifacts", () => {
  it.each(packages)("%s emits JavaScript and declarations without unresolved @/ aliases", (name) => {
    const files = readdirSync(distDirectory(name)).filter(file => file.endsWith(".js") || file.endsWith(".d.ts"));
    expect(files.some(file => file.endsWith(".js"))).toBe(true);
    expect(files.some(file => file.endsWith(".d.ts"))).toBe(true);

    for (const file of files) {
      const contents = readFileSync(join(distDirectory(name), file), "utf8");
      expect({ file, leaksAlias: /from\s+["']@\//.test(contents) || /import\(\s*["']@\//.test(contents) })
        .toEqual({ file, leaksAlias: false });
    }
  });
});

describe("holqa bin", () => {
  it("runs the built CLI with Bun and reports structured diagnostics", () => {
    const bin = join(distDirectory("@holqa/cli"), "bin.js");

    const help = Bun.spawnSync(["bun", bin, "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("Usage: holqa");

    const proposed = Bun.spawnSync(["bun", bin, "dev", "--json"]);
    expect(proposed.exitCode).toBe(1);
    const output = JSON.parse(proposed.stderr.toString()) as { diagnostics: Array<{ code: string }> };
    expect(output.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_CLI_NOT_IMPLEMENTED"]);
  });
});

describe("compiler artifacts", () => {
  it("ships the manifest JSON Schemas through the package exports", () => {
    const manifestSchema = JSON.parse(readFileSync(require.resolve("@holqa/compiler/manifest-v1.schema.json"), "utf8")) as { $id: string };
    const entrypointsSchema = JSON.parse(readFileSync(require.resolve("@holqa/compiler/entrypoints-v1.schema.json"), "utf8")) as { $id: string };
    expect([manifestSchema.$id, entrypointsSchema.$id]).toEqual(["urn:holqa:schema:manifest:1", "urn:holqa:schema:entrypoints:1"]);
  });

  it("ships the CLI's analysis entry point next to its binary", () => {
    expect(readdirSync(distDirectory("@holqa/cli"))).toEqual(expect.arrayContaining(["analyze.js", "bin.js", "index.js"]));
  });
});