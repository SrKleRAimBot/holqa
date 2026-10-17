import type { Result } from "@holqa/core";
import type { AppDescriptor } from "@holqa/experiment-model";

import type { RuntimeDiagnostic } from "@/diagnostics";

import {
  err,
  ok
} from "@holqa/core";
import { experimentCodes } from "@holqa/experiment-model";

import { runtimeError } from "@/diagnostics";

/** Raw configuration input, for example `process.env`. */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * Validates every configuration entry an application declares against its
 * schema, applying variable defaults. Secrets are reported by name only: their
 * values and the schema's issue messages (which may echo the value) never
 * appear in diagnostics.
 *
 * @param app - The application descriptor.
 * @param env - Raw configuration values.
 * @returns Validated values by entry name, or `HOLQA_CONFIG_INVALID` diagnostics for every invalid entry.
 */
export async function resolveConfig(app: AppDescriptor, env: EnvRecord): Promise<Result<ReadonlyMap<string, unknown>, RuntimeDiagnostic[]>> {
  const values = new Map<string, unknown>();
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const entry of app.config) {
    const raw: unknown = env[entry.name] ?? entry.defaultValue;
    const result = await entry.schema["~standard"].validate(raw);
    if (result.issues === undefined) {
      values.set(entry.name, result.value);
      continue;
    }
    diagnostics.push(entry.sensitive
      ? runtimeError(experimentCodes.configInvalid, `Secret "${entry.name}" is missing or invalid.`, { hint: `Provide ${entry.name} through the environment.` })
      : runtimeError(experimentCodes.configInvalid, `Variable "${entry.name}" is invalid: ${result.issues.map(issue => issue.message).join("; ")}`));
  }
  return diagnostics.length > 0 ? err(diagnostics) : ok(values);
}