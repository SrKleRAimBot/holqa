// Entry point of the provider test process. It runs with the CLI's whole
// environment, because the providers under test resolve their credentials
// from it, and it may reach infrastructure. The CLI sends the request as the
// first argument and receives the report over IPC.
import { pathToFileURL } from "node:url";

import {
  isProviderTests,
  runProviderTests
} from "@holqa/conformance";
import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

/** The request the CLI sends. */
interface TestRequest {
  readonly module: string;
  readonly display: string;
  readonly only?: readonly string[];
  readonly timeoutMs: number;
}

/**
 * Loads the module and runs its provider tests.
 *
 * @param request - The module, entry selection and time limit.
 * @returns The JSON-ready outcome.
 */
async function run(request: TestRequest): Promise<unknown> {
  let exported: unknown;
  try {
    exported = (await import(pathToFileURL(request.module).href) as { readonly default?: unknown }).default;
  } catch (error) {
    return { ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.moduleEvaluationFailed, severity: "error", message: `Evaluating "${request.display}" failed: ${error instanceof Error ? error.message : String(error)}` })] };
  }
  if (!isProviderTests(exported))
    return { ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.cliArgumentInvalid, severity: "error", message: `The module "${request.display}" does not export provider tests as its default export.`, hint: "Export default defineProviderTests([providerTest(name, suite, harness), ...]) from @holqa/conformance." })] };
  const names = exported.entries.map(entry => entry.name);
  const unknown = (request.only ?? []).filter(name => !names.includes(name));
  if (unknown.length > 0)
    return { ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.cliArgumentInvalid, severity: "error", message: `No provider test is named ${unknown.map(name => `"${name}"`).join(", ")}; the module defines ${names.map(name => `"${name}"`).join(", ")}.` })] };
  return { ok: true, report: await runProviderTests(exported, { ...request.only === undefined ? {} : { only: request.only }, timeoutMs: request.timeoutMs }) };
}

const outcome = await run(JSON.parse(process.argv[2] ?? "{}") as TestRequest);
if (process.send === undefined) {
  process.stderr.write("The provider test process must be started with an IPC channel.\n");
  process.exit(1);
}
process.send(JSON.stringify(outcome));