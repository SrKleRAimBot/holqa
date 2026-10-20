// Entry point of the provisioning process. Unlike analysis, it runs with the
// CLI's whole environment, because provisioners resolve administrative
// credentials from it, and it may reach infrastructure. The CLI sends the
// request as the first argument and receives the outcome over IPC.
import type { DeliveredHandler } from "@holqa/core";

import { pathToFileURL } from "node:url";

import {
  applyProvisioning,
  isProvisioningDefinition,
  planProvisioning
} from "@holqa/bindings";
import {
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf
} from "@holqa/core";

/** The request the CLI sends. */
interface ProvisionRequest {
  readonly module: string;
  readonly display: string;
  readonly mode: "plan" | "apply";
  readonly allowDestructive: boolean;
  readonly handlers: readonly DeliveredHandler[];
}

/**
 * Loads the provisioning module, plans or applies, and returns the outcome.
 *
 * @param request - The module, mode and handlers.
 * @returns The JSON-ready outcome.
 */
async function run(request: ProvisionRequest): Promise<unknown> {
  let exported: unknown;
  try {
    exported = (await import(pathToFileURL(request.module).href) as { readonly default?: unknown }).default;
  } catch (error) {
    return { ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.moduleEvaluationFailed, severity: "error", message: `Evaluating "${request.display}" failed: ${error instanceof Error ? error.message : String(error)}` })] };
  }
  if (!isProvisioningDefinition(exported))
    return { ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.provisioningConfigInvalid, severity: "error", message: `The module "${request.display}" does not export a provisioning configuration as its default export.`, hint: "Export default defineProvisioning(bindings, { provisioners: [...] }) from @holqa/bindings." })] };
  const options = { handlers: request.handlers, lookup: (name: string) => process.env[name] };
  try {
    if (request.mode === "plan")
      return { ok: true, plan: await planProvisioning(exported, options) };
    return { ok: true, ...await applyProvisioning(exported, { ...options, allowDestructive: request.allowDestructive }) };
  } catch (error) {
    const diagnostics = diagnosticsOf(error);
    return { ok: false, diagnostics: diagnostics.length > 0 ? diagnostics : [createDiagnostic({ code: diagnosticCodes.provisioningFailed, severity: "error", message: error instanceof Error ? error.message : String(error) })] };
  }
}

const outcome = await run(JSON.parse(process.argv[2] ?? "{}") as ProvisionRequest);
if (process.send === undefined) {
  process.stderr.write("The provisioning process must be started with an IPC channel.\n");
  process.exit(1);
}
process.send(JSON.stringify(outcome));