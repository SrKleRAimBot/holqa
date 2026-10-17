// Bun host for the compilation experiment: evaluates an application and its
// handler modules (which runs their code), then calls the neutral compiler.
//
// Usage: bun tests/support/load-and-compile.ts <app-root> [shuffle-seed]
// Prints one JSON object: { ok, diagnostics, manifest } where `manifest` is the
// canonical JSON text, or null when the application could not be loaded.
import type {
  CompilerDiagnostic,
  EvaluatedModule
} from "@/index";

import { join } from "node:path";
import { getAppDescriptor } from "@holqa/experiment-model";
import { zodAdapter } from "@holqa/experiment-schema-adapters";

import {
  compileApp,
  moduleEvaluationFailure,
  serializeManifest
} from "@/index";

/**
 * Creates a deterministic pseudo-random number generator (mulberry32), used
 * to shuffle discovery order reproducibly.
 *
 * @param seed - The integer seed.
 * @returns A function returning numbers in [0, 1).
 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shuffles an array in place with the Fisher-Yates algorithm.
 *
 * @param values - The array to shuffle.
 * @param next - The random number source.
 * @returns The same array, shuffled.
 */
function shuffle<T>(values: T[], next: () => number): T[] {
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [values[index], values[other]] = [values[other]!, values[index]!];
  }
  return values;
}

/**
 * Loads the application at `root`, discovers and evaluates its handler
 * modules, compiles it and writes the result to standard output.
 *
 * @param root - Absolute path of the application root (the directory of `infra.ts`).
 * @param seed - Optional seed; when present, modules are evaluated and passed in shuffled order.
 */
async function main(root: string, seed: string | undefined): Promise<void> {
  const diagnostics: CompilerDiagnostic[] = [];
  let appExport: unknown;
  try {
    appExport = (await import(join(root, "infra.ts"))).default;
  } catch (error) {
    diagnostics.push(moduleEvaluationFailure("infra.ts", error));
  }

  const app = getAppDescriptor(appExport);
  const paths = new Set<string>();
  for (const pattern of app?.handlers ?? []) {
    for await (const path of new Bun.Glob(pattern.replace(/^\.\//, "")).scan({ cwd: root }))
      paths.add(path.split("\\").join("/"));
  }
  const ordered = [...paths].sort();
  if (seed !== undefined)
    shuffle(ordered, random(Number(seed)));

  const modules: EvaluatedModule[] = [];
  for (const path of ordered) {
    try {
      modules.push({ path, exports: { ...(await import(join(root, path))) } });
    } catch (error) {
      diagnostics.push(moduleEvaluationFailure(path, error));
    }
  }

  const result = await compileApp({ app: appExport, modules, adapters: [zodAdapter] });
  const all = [...diagnostics, ...result.diagnostics];
  process.stdout.write(JSON.stringify({
    ok: result.ok && diagnostics.length === 0,
    diagnostics: all,
    manifest: result.manifest === undefined ? null : serializeManifest(result.manifest)
  }));
}

main(process.argv[2]!, process.argv[3]).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});