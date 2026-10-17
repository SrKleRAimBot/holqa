import type {
  CompilerDiagnostic,
  EvaluatedModule
} from "@holqa/experiment-compiler";

import { join } from "node:path";
import {
  compileApp,
  moduleEvaluationFailure
} from "@holqa/experiment-compiler";
import { zodAdapter } from "@holqa/experiment-schema-adapters";

/** The example's root directory, which contains `infra.ts`. */
export const appRoot = join(import.meta.dir, "..");

/**
 * Evaluates `infra.ts` and every module matched by its handler globs, in sorted
 * order, the way the proposed CLI host would. This runs the application's code.
 *
 * @returns The application export, the evaluated modules and evaluation failures.
 */
export async function loadApplication(): Promise<{ readonly app: unknown; readonly modules: EvaluatedModule[]; readonly failures: CompilerDiagnostic[] }> {
  const app: unknown = (await import(join(appRoot, "infra.ts"))).default;
  const paths: string[] = [];
  for await (const path of new Bun.Glob("src/**/*.handler.ts").scan({ cwd: appRoot }))
    paths.push(path.split("\\").join("/"));
  const modules: EvaluatedModule[] = [];
  const failures: CompilerDiagnostic[] = [];
  for (const path of paths.sort()) {
    try {
      modules.push({ path, exports: await import(join(appRoot, path)) as Record<string, unknown> });
    } catch (error) {
      failures.push(moduleEvaluationFailure(path, error));
    }
  }
  return { app, modules, failures };
}

/**
 * Loads and compiles the example with the Zod adapter.
 *
 * @returns The compiler's result plus any module evaluation failures.
 */
export async function compileExample(): Promise<Awaited<ReturnType<typeof compileApp>> & { readonly failures: CompilerDiagnostic[] }> {
  const { app, modules, failures } = await loadApplication();
  return { ...(await compileApp({ app, modules, adapters: [zodAdapter] })), failures };
}