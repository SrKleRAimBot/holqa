import type { ProviderTestReport } from "@holqa/conformance";
import type { Diagnostic } from "@holqa/core";

import type { CliHost } from "@/analysis/host";
import type { OptionSpec } from "@/arguments";
import type { CliIo } from "@/io";

import { existsSync } from "node:fs";
import {
  dirname,
  relative,
  resolve
} from "node:path";

import { canonicalJsonStringify } from "@holqa/compiler";
import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

import { parseOptions } from "@/arguments";
import {
  defaultAppModule,
  reportDiagnostics
} from "@/commands/analysis-command";
import { runTrustedProcess } from "@/commands/trusted-process";
import { exitCodes } from "@/exit-codes";

/** The provider test module used when `--tests` is not given, next to the application module. */
export const defaultProviderTestsModule = "conformance.ts";

/** The options of `holqa providers test`. */
const options: OptionSpec = { flags: [], values: ["app", "tests", "only", "timeout"] };

/** What the provider test process reports. */
type TestOutcome = { readonly ok: true; readonly report: ProviderTestReport } | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Formats a report for people: one line per case, failures with their
 * reasons, and a summary.
 *
 * @param report - The report from the test process.
 * @returns The text.
 */
function formatReport(report: ProviderTestReport): string {
  const marks = { passed: "✓", failed: "✗", skipped: "-" } as const;
  const lines: string[] = [];
  for (const suite of report.suites) {
    lines.push(`${suite.name} (${suite.contract})`);
    for (const result of suite.results)
      lines.push(`  ${marks[result.status]} ${result.name}${result.status === "passed" ? "" : `: ${result.message ?? result.status}`}`);
  }
  lines.push("", `${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`);
  return lines.join("\n");
}

/**
 * Runs `holqa providers test`: loads a provider test module (`--tests`,
 * default `conformance.ts` next to the application module) whose default
 * export pairs conformance suites with harnesses for the providers under
 * test, runs them in a separate Bun process with the CLI's environment (the
 * providers' credentials), and reports every case.
 *
 * @param host - The CLI host, for the working directory.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param rest - The arguments after `providers test`.
 * @returns `0` when no case failed; `1` when one failed or the module could not run; `2` for invalid arguments.
 */
export async function providersTestCommand(host: CliHost, io: CliIo, json: boolean, rest: readonly string[]): Promise<number> {
  const parsed = parseOptions(rest, options);
  const timeout = parsed.ok ? parsed.values.get("timeout") : undefined;
  if (!parsed.ok || (timeout !== undefined && !/^[1-9]\d{0,6}$/.test(timeout))) {
    const problems = parsed.ok ? ["--timeout must be a whole number of milliseconds from 1 to 9999999."] : parsed.problems;
    reportDiagnostics(io, json, problems.map(problem => createDiagnostic({ code: diagnosticCodes.cliArgumentInvalid, severity: "error", message: `holqa providers test: ${problem}`, hint: "Run \"holqa --help\" for the options of \"holqa providers test\"." })));
    return exitCodes.usage;
  }
  const appPath = resolve(host.cwd, parsed.values.get("app") ?? defaultAppModule);
  const module = resolve(host.cwd, parsed.values.get("tests") ?? resolve(dirname(appPath), defaultProviderTestsModule));
  const display = relative(host.cwd, module) || module;
  if (!existsSync(module)) {
    reportDiagnostics(io, json, [createDiagnostic({ code: diagnosticCodes.fileUnreadable, severity: "error", message: `The provider test module "${display}" does not exist.`, hint: "Create conformance.ts (export default defineProviderTests([...]) from @holqa/conformance), or pass --tests <path>." })]);
    return exitCodes.failure;
  }
  const only = parsed.values.get("only")?.split(",").map(name => name.trim()).filter(name => name !== "");
  const { message, exitCode, errors } = await runTrustedProcess({ source: "../providers/test-entry.ts", built: "./provider-tests.js" }, { module, display, ...only === undefined ? {} : { only }, timeoutMs: timeout === undefined ? 30_000 : Number(timeout) }, dirname(module));
  const outcome: TestOutcome = message !== undefined
    ? JSON.parse(message) as TestOutcome
    : { ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.moduleEvaluationFailed, severity: "error", message: `The provider test process exited with code ${exitCode} without a report.`, details: { output: errors } })] };
  if (!outcome.ok) {
    reportDiagnostics(io, json, outcome.diagnostics);
    return exitCodes.failure;
  }
  io.stdout(json ? canonicalJsonStringify(outcome.report) : formatReport(outcome.report));
  return outcome.report.summary.failed > 0 ? exitCodes.failure : exitCodes.success;
}