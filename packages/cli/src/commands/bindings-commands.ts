import type { BindingReport } from "@holqa/bindings";
import type { Manifest } from "@holqa/compiler";
import type { Diagnostic } from "@holqa/core";

import type { CliHost } from "@/analysis/host";
import type { OptionSpec } from "@/arguments";
import type { CliIo } from "@/io";

import {
  dirname,
  resolve
} from "node:path";

import { canonicalJsonStringify } from "@holqa/compiler";
import {
  bindingFailure,
  createDiagnostic,
  diagnosticCodes,
  formatDiagnostic
} from "@holqa/core";

import { parseOptions } from "@/arguments";
import {
  analyzeApplication,
  defaultAppModule,
  reportDiagnostics
} from "@/commands/analysis-command";
import { exitCodes } from "@/exit-codes";
import { formatBindingReport } from "@/output/bindings";

/** The binding configuration module used when `--bindings` is not given, next to the application module. */
export const defaultBindingsModule = "bindings.ts";

/** The binding commands, by their words. */
export const bindingsCommandNames = ["bindings inspect", "bindings validate"] as const;

/** One of {@link bindingsCommandNames}. */
export type BindingsCommandName = (typeof bindingsCommandNames)[number];

/** The options of every binding command. */
const options: OptionSpec = { flags: [], values: ["app", "bindings"] };

/**
 * Finds the binding command whose words start the arguments.
 *
 * @param args - The arguments after the executable, without `--json`.
 * @returns The command and the remaining arguments, or `undefined`.
 */
export function matchBindingsCommand(args: readonly string[]): { readonly name: BindingsCommandName; readonly rest: readonly string[] } | undefined {
  const name = bindingsCommandNames.find(candidate => candidate.split(" ").every((word, index) => args[index] === word));
  return name === undefined ? undefined : { name, rest: args.slice(2) };
}

/**
 * Runs `holqa bindings inspect` or `holqa bindings validate`: analyzes the
 * application, resolves the binding configuration module (`--bindings`,
 * default `bindings.ts` next to the application module) against it without
 * opening any provider, and prints which provider binds each resource and
 * service and why (`inspect`) or every problem (`validate`).
 *
 * `validate` also checks that credentials and required configuration values
 * are set when every configuration source reads the process environment.
 *
 * @param host - The CLI host.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param name - Which binding command.
 * @param rest - The arguments after the command words.
 * @returns `0` on success; `1` when analysis fails or (for `validate`) the configuration has errors; `2` for invalid arguments.
 */
export async function bindingsCommand(host: CliHost, io: CliIo, json: boolean, name: BindingsCommandName, rest: readonly string[]): Promise<number> {
  const parsed = parseOptions(rest, options);
  if (!parsed.ok) {
    reportDiagnostics(io, json, parsed.problems.map(problem => createDiagnostic({ code: diagnosticCodes.cliArgumentInvalid, severity: "error", message: `holqa ${name}: ${problem}`, hint: `Run "holqa --help" for the options of "holqa ${name}".` })));
    return exitCodes.usage;
  }
  const app = parsed.values.get("app");
  const appPath = resolve(host.cwd, app ?? defaultAppModule);
  const bindingsPath = resolve(host.cwd, parsed.values.get("bindings") ?? resolve(dirname(appPath), defaultBindingsModule));
  const result = await analyzeApplication(host, io, json, app, { bindingsPath });
  if (result === undefined)
    return exitCodes.failure;
  const report = result.analysis.bindings;
  if (report === undefined) {
    reportDiagnostics(io, json, [createDiagnostic({ code: diagnosticCodes.analysisFailed, severity: "error", message: "The analysis did not resolve the binding configuration; this CLI host does not support binding commands." })]);
    return exitCodes.failure;
  }
  if (name === "bindings inspect") {
    io.stdout(json ? canonicalJsonStringify({ bindings: report, diagnostics: result.analysis.diagnostics }) : formatBindingReport(report));
    return exitCodes.success;
  }
  const environment = host.environment === undefined ? undefined : checkEnvironment(report, result.analysis.manifest, host.environment);
  const diagnostics = [...report.diagnostics, ...environment ?? []];
  const valid = !diagnostics.some(diagnostic => diagnostic.severity === "error");
  if (json) {
    io.stdout(canonicalJsonStringify({ credentialsChecked: environment !== undefined, diagnostics, valid }));
  } else {
    if (diagnostics.length > 0)
      io.stderr(diagnostics.map(formatDiagnostic).join("\n"));
    io.stdout([
      valid
        ? `The binding configuration "${report.name}" is valid: ${report.resources.length} resource${report.resources.length === 1 ? "" : "s"}, ${report.providers.length} provider${report.providers.length === 1 ? "" : "s"}.`
        : `The binding configuration "${report.name}" is invalid: ${diagnostics.filter(diagnostic => diagnostic.severity === "error").length} error(s).`,
      ...environment === undefined ? ["Credentials and configuration values were not checked: they are read from their configuration sources when the application starts."] : []
    ].join("\n"));
  }
  return valid ? exitCodes.success : exitCodes.failure;
}

/**
 * Checks that every credential and every configuration value without a
 * default is set, when every configuration source reads the process
 * environment. Values are never printed; only names are. A missing
 * credential is an error; a missing configuration value is a warning, because
 * its schema may accept no value.
 *
 * @param report - The binding report.
 * @param manifest - The application's manifest, for its configuration entries.
 * @param environment - The process environment.
 * @returns One diagnostic per missing name, or `undefined` when the configuration sources cannot be checked before starting.
 */
function checkEnvironment(report: BindingReport, manifest: Manifest, environment: Readonly<Record<string, string | undefined>>): Diagnostic[] | undefined {
  const config = report.services.find(service => service.service === "config");
  const sources = report.providers.filter(provider => config?.providers.includes(provider.name));
  if (sources.length === 0 || sources.some(provider => (provider.settings as { readonly source?: unknown }).source !== "environment"))
    return undefined;
  /**
   * Reports whether an environment variable has a value.
   *
   * @param name - The variable's name.
   * @returns `true` when it is set and not empty.
   */
  const set = (name: string): boolean => environment[name] !== undefined && environment[name] !== "";
  const problems: Diagnostic[] = [];
  for (const provider of report.providers) {
    for (const credential of provider.credentials) {
      if (!set(credential))
        problems.push(bindingFailure("credentials-missing", { binding: provider.name, message: `The credential ${credential} that provider "${provider.name}" needs is not set.`, hint: `Set the environment variable ${credential}.`, details: { credential } }));
    }
  }
  for (const entry of manifest.config) {
    if (entry.default === undefined && !set(entry.name))
      problems.push(createDiagnostic({ code: diagnosticCodes.configInvalid, severity: "warning", message: `The ${entry.kind} ${entry.name} has no default and is not set; the application fails to start unless its schema accepts no value.`, hint: `Set the environment variable ${entry.name} before starting the application.`, details: { name: entry.name, kind: entry.kind, missing: true } }));
  }
  return problems;
}