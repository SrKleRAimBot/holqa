import type {
  AnalysisOutcome,
  CliHost
} from "@/analysis/host";

import { compileApplication } from "@holqa/compiler";
import {
  application,
  consumer,
  queue,
  secret
} from "@test/support/descriptors";

/** A host that records calls instead of spawning processes or writing files. */
export interface FakeHost extends CliHost {
  /** Every application path passed to `analyze`. */
  readonly analyzed: string[];
  /** Every file written, by absolute path. */
  readonly written: Map<string, string>;
}

/**
 * Compiles a small application in memory, as a successful analysis would.
 *
 * @returns A successful analysis outcome with one queue, one consumer and one secret.
 * @throws {Error} When the fixture does not compile, which indicates a broken test.
 */
export async function compiledOutcome(): Promise<AnalysisOutcome> {
  const result = await compileApplication({
    app: application("basic", [queue("orders")], [secret("API_TOKEN")]),
    appModule: "infra.ts",
    modules: [{ path: "src/orders.handler.ts", exports: { default: consumer("orders.process", "orders") } }],
    runtime: "bun"
  });
  if (!result.ok)
    throw new Error(JSON.stringify(result.diagnostics));
  return { ...result, output: "evaluating\n" };
}

/**
 * Creates a fake host.
 *
 * @param outcome - What every analysis returns.
 * @param options - Behaviour overrides.
 * @param options.failWrites - Make every write reject.
 * @returns The host, which records analyzed paths and written files.
 */
export function fakeHost(outcome: AnalysisOutcome, options: { readonly failWrites?: boolean } = {}): FakeHost {
  const analyzed: string[] = [];
  const written = new Map<string, string>();
  return {
    cwd: "/work/shop",
    analyzed,
    written,
    analyze: async (appPath) => {
      analyzed.push(appPath);
      return outcome;
    },
    writeFile: async (path, contents) => {
      if (options.failWrites === true)
        throw new Error("read-only file system");
      written.set(path, contents);
    }
  };
}