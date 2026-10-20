import type {
  ProvisioningPlan,
  ProvisioningResult
} from "@holqa/bindings";
import type {
  DeliveredHandler,
  Diagnostic,
  PlannedChange
} from "@holqa/core";

import type { CliHost } from "@/analysis/host";
import type { OptionSpec } from "@/arguments";
import type { CliIo } from "@/io";

import { existsSync } from "node:fs";
import {
  dirname,
  relative,
  resolve
} from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonStringify } from "@holqa/compiler";
import {
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

/** The provisioning module used when `--provisioning` is not given, next to the application module. */
export const defaultProvisioningModule = "provisioning.ts";

/** The provisioning commands, by their words. */
export const provisionCommandNames = ["provision plan", "provision apply"] as const;

/** One of {@link provisionCommandNames}. */
export type ProvisionCommandName = (typeof provisionCommandNames)[number];

/** The options of the provisioning commands. */
const options: OptionSpec = { flags: ["allow-destructive"], values: ["app", "provisioning"] };

/** What the provisioning process reports. */
type ProvisionOutcome
  = | { readonly ok: true; readonly plan: ProvisioningPlan; readonly result?: ProvisioningResult }
    | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Finds the provisioning command whose words start the arguments.
 *
 * @param args - The arguments after the executable, without `--json`.
 * @returns The command and the remaining arguments, or `undefined`.
 */
export function matchProvisionCommand(args: readonly string[]): { readonly name: ProvisionCommandName; readonly rest: readonly string[] } | undefined {
  const name = provisionCommandNames.find(candidate => candidate.split(" ").every((word, index) => args[index] === word));
  return name === undefined ? undefined : { name, rest: args.slice(2) };
}

/**
 * Returns the provisioning process's entry point, from source or from the build.
 *
 * @returns Its absolute path.
 */
function entryPath(): string {
  const fromSource = import.meta.url.endsWith(".ts");
  return fileURLToPath(new URL(fromSource ? "../provision/provision-entry.ts" : "./provision.js", import.meta.url));
}

/**
 * Runs the provisioning module in a separate Bun process with the CLI's
 * environment, which holds the provisioners' credentials, and receives the
 * outcome over IPC.
 *
 * @param request - The module, its display path, the mode and the handlers.
 * @param request.module - The provisioning module, absolute.
 * @param request.display - Its path for messages.
 * @param request.mode - `plan` or `apply`.
 * @param request.allowDestructive - Whether destructive changes are authorized.
 * @param request.handlers - The manifest's handlers.
 * @param cwd - The process's working directory.
 * @returns The outcome.
 */
async function runProvisioning(request: { readonly module: string; readonly display: string; readonly mode: "plan" | "apply"; readonly allowDestructive: boolean; readonly handlers: readonly DeliveredHandler[] }, cwd: string): Promise<ProvisionOutcome> {
  let message: string | undefined;
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-install", entryPath(), JSON.stringify(request)],
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "pipe",
    ipc: (received) => {
      message ??= typeof received === "string" ? received : undefined;
      child.kill();
    }
  });
  const [exitCode, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (message !== undefined)
    return JSON.parse(message) as ProvisionOutcome;
  return { ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.provisioningFailed, severity: "error", message: `The provisioning process exited with code ${exitCode} without a result.`, details: { output: errors.slice(-4_000) } })] };
}

/** Markers of each action in human-readable plans. */
const markers: Readonly<Record<PlannedChange["action"], string>> = { create: "+", update: "~", replace: "!", delete: "-", none: "=" };

/**
 * Formats a plan for people: the changes, the unchanged count, the resources
 * that must already exist, and problems.
 *
 * @param plan - The plan reported by the provisioning process.
 * @returns The text.
 */
function formatPlan(plan: ProvisioningPlan): string {
  const changes = plan.changes.filter(change => change.action !== "none");
  const lines = [`Provisioning plan for "${plan.binding}" (application "${plan.application}")`, ""];
  if (changes.length === 0)
    lines.push("No changes: the infrastructure is as needed.");
  for (const change of changes)
    lines.push(`  ${markers[change.action]} ${change.action.padEnd(7)} ${change.type} ${change.target}${change.destructive ? "  [destructive]" : ""}`, `      ${change.reason} (${change.provisioner})`);
  lines.push("", `Unchanged: ${plan.changes.length - changes.length}.`);
  if (plan.unprovisioned.length > 0)
    lines.push(`Not provisioned here (must exist): ${plan.unprovisioned.map(entry => `${entry.resource} (${entry.provider})`).join(", ")}.`);
  if (plan.diagnostics.length > 0)
    lines.push("", ...plan.diagnostics.map(formatDiagnostic));
  return lines.join("\n");
}

/**
 * Runs `holqa provision plan` and `holqa provision apply`: analyzes the
 * application for its handlers, then loads the provisioning module
 * (`--provisioning`, default `provisioning.ts` next to the application
 * module) in a separate process with the CLI's environment, and plans or
 * applies. `plan` only reads infrastructure. `apply` plans again and applies
 * nothing when the plan has errors, or a destructive change without
 * `--allow-destructive`.
 *
 * @param host - The CLI host.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param name - Which command.
 * @param rest - The arguments after the command words.
 * @returns `0` on success; `1` when the plan or apply has errors; `2` for invalid arguments.
 */
export async function provisionCommand(host: CliHost, io: CliIo, json: boolean, name: ProvisionCommandName, rest: readonly string[]): Promise<number> {
  const parsed = parseOptions(rest, options);
  if (!parsed.ok || (name === "provision plan" && parsed.flags.has("allow-destructive"))) {
    const problems = parsed.ok ? ["--allow-destructive applies only to \"holqa provision apply\"."] : parsed.problems;
    reportDiagnostics(io, json, problems.map(problem => createDiagnostic({ code: diagnosticCodes.cliArgumentInvalid, severity: "error", message: `holqa ${name}: ${problem}`, hint: `Run "holqa --help" for the options of "holqa ${name}".` })));
    return exitCodes.usage;
  }
  const app = parsed.values.get("app");
  const appPath = resolve(host.cwd, app ?? defaultAppModule);
  const module = resolve(host.cwd, parsed.values.get("provisioning") ?? resolve(dirname(appPath), defaultProvisioningModule));
  const display = relative(host.cwd, module) || module;
  if (!existsSync(module)) {
    reportDiagnostics(io, json, [createDiagnostic({ code: diagnosticCodes.fileUnreadable, severity: "error", message: `The provisioning module "${display}" does not exist.`, hint: "Create provisioning.ts next to infra.ts (export default defineProvisioning(bindings, { provisioners: [...] })), or pass --provisioning <path>." })]);
    return exitCodes.failure;
  }
  const result = await analyzeApplication(host, io, json, app);
  if (result === undefined)
    return exitCodes.failure;
  const outcome = await runProvisioning({ module, display, mode: name === "provision plan" ? "plan" : "apply", allowDestructive: parsed.flags.has("allow-destructive"), handlers: result.analysis.manifest.handlers as unknown as readonly DeliveredHandler[] }, dirname(appPath));
  if (!outcome.ok) {
    reportDiagnostics(io, json, outcome.diagnostics);
    return exitCodes.failure;
  }
  const errors = [...outcome.plan.diagnostics, ...outcome.result?.diagnostics ?? []].some(diagnostic => diagnostic.severity === "error");
  if (json) {
    io.stdout(canonicalJsonStringify({ plan: outcome.plan, ...outcome.result === undefined ? {} : { result: outcome.result } }));
    return errors ? exitCodes.failure : exitCodes.success;
  }
  io.stdout(formatPlan(outcome.plan));
  if (outcome.result !== undefined) {
    const applied = outcome.result.applied;
    io.stdout(["", applied.length === 0 ? (outcome.result.diagnostics.length === 0 ? "Nothing to apply." : "Nothing was applied.") : `Applied ${applied.filter(item => item.status === "applied").length} of ${outcome.plan.changes.filter(change => change.action !== "none").length} changes.`, ...applied.filter(item => item.status !== "applied").map(item => `  ${item.status}: ${item.change.type} ${item.change.target}${item.message === undefined ? "" : ` (${item.message})`}`), ...outcome.result.diagnostics.map(formatDiagnostic)].join("\n"));
  }
  return errors ? exitCodes.failure : exitCodes.success;
}