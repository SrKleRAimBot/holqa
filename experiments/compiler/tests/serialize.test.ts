import type { CompilerDiagnostic } from "@/diagnostics";

import {
  cpSync,
  mkdirSync,
  rmSync
} from "node:fs";
import { join } from "node:path";
import { experimentCodes } from "@holqa/experiment-model";
import {
  afterAll,
  describe,
  expect,
  it
} from "bun:test";

import { serializeManifest } from "@/serialize";

/** The package root; scratch copies live under `.tmp/` so that module resolution still finds `node_modules`. */
const packageRoot = join(import.meta.dir, "..");
const scratch = join(packageRoot, ".tmp", `serialize-${process.pid}`);
const loader = join(import.meta.dir, "support", "load-and-compile.ts");

/** What the loader prints. */
interface LoaderOutput {
  readonly ok: boolean;
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly manifest: string | null;
}

/**
 * Copies a fixture application to a fresh directory under the scratch root.
 *
 * @param fixture - The fixture directory name under `tests/fixtures/`.
 * @param copy - A name that makes the destination unique.
 * @returns The absolute path of the copy.
 */
function copyFixture(fixture: string, copy: string): string {
  const destination = join(scratch, copy, fixture);
  mkdirSync(destination, { recursive: true });
  cpSync(join(import.meta.dir, "fixtures", fixture), destination, { recursive: true });
  return destination;
}

/**
 * Runs the Bun loader in a separate process, as a CLI would.
 *
 * @param root - The application root.
 * @param seed - Optional discovery-order shuffle seed.
 * @param env - Extra environment variables for the child process.
 * @returns The parsed loader output.
 * @throws {Error} When the loader process fails.
 */
function load(root: string, seed?: number, env: Record<string, string> = {}): LoaderOutput {
  const child = Bun.spawnSync(["bun", loader, root, ...(seed === undefined ? [] : [String(seed)])], { env: { ...process.env, ...env } });
  if (child.exitCode !== 0)
    throw new Error(`Loader failed: ${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString()) as LoaderOutput;
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("serializeManifest", () => {
  it("rejects manifests containing values with no canonical form", () => {
    expect(() => serializeManifest({ manifestVersion: 0, app: { name: "x", handlers: [] }, resources: [{ id: "a", kind: "queue", config: { bad: undefined as never }, schemas: {} }], handlers: [], configuration: [], schemas: {} })).toThrow();
  });
});

describe("end-to-end determinism", () => {
  it("produces byte-identical manifests across processes, directories and discovery orders", () => {
    const first = copyFixture("commerce", "first");
    const second = copyFixture("commerce", "second-copy-with-a-longer-path");
    const outputs = [load(first), load(first), load(second, 1), load(second, 7), load(first, 42)];
    for (const output of outputs) {
      expect(output.ok).toBe(true);
      expect(output.diagnostics).toEqual([]);
      expect(output.manifest).toBe(outputs[0]!.manifest);
    }
    const manifest = outputs[0]!.manifest!;
    expect(manifest).not.toContain(packageRoot);
    expect(manifest).not.toContain(".tmp");
    expect(manifest).not.toContain("\\");
  });

  it("extracts handlers from separate modules, including a module with two handlers, and imported schemas", () => {
    const manifest = JSON.parse(load(copyFixture("commerce", "shape")).manifest!) as { handlers: { id: string; module: string; exports: string[] }[]; resources: { id: string; schemas: Record<string, { input: string }> }[]; schemas: Record<string, { jsonSchema: unknown }> };
    expect(manifest.handlers.filter(handler => handler.module === "src/orders/order-queries.handler.ts").map(handler => handler.exports)).toEqual([["getOrder"], ["listOrders"]]);
    const { message } = manifest.resources.find(resource => resource.id === "order-processing")!.schemas;
    expect(JSON.stringify(manifest.schemas[message!.input]!.jsonSchema)).toContain("quantity");
  });

  it("never writes secret values into the manifest", () => {
    const value = "postgres://user:hunter2@db.internal/app";
    const output = load(copyFixture("commerce", "secrets"), undefined, { DATABASE_URL: value });
    expect(output.manifest).not.toContain("hunter2");
    expect(output.manifest).toContain("DATABASE_URL");
  });

  it("reports top-level configuration access as a module evaluation failure", () => {
    const output = load(copyFixture("top-level-config", "top-level"));
    expect(output.ok).toBe(false);
    const failure = output.diagnostics.find(diagnostic => diagnostic.code === experimentCodes.moduleEvaluationFailed)!;
    expect(failure.location).toEqual({ file: "src/report.handler.ts" });
    expect(failure.message).toContain(experimentCodes.runtimeNotBound);
  });
});