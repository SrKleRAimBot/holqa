import type {
  AppDescriptor,
  ConfigDescriptor,
  Diagnostic,
  RuntimeBinding
} from "@holqa/core";

import {
  createDiagnostic,
  diagnosticCodes,
  HolqaError,
  InputValidationError,
  validateInput
} from "@holqa/core";

/** Environment variables by name, as `process.env` provides them. */
export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/**
 * Creates the binding the runtime installs when the caller supplies none. It
 * serves HTTP APIs, which need no driver, and reads configuration from
 * environment variables. It declares no queue, bucket or schedule
 * capability, so an application that declares those resources fails to start
 * with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` instead of silently losing
 * messages; pass a binding that provides them instead.
 *
 * Every configuration entry is validated before the application runs: a
 * missing value falls back to the declared default, and the value (or its
 * absence) must satisfy the entry's schema. Values arrive as strings, so
 * schemas for other types should coerce (for example `z.coerce.number()`).
 *
 * @param app - The application whose configuration is read.
 * @param env - Environment variables by name.
 * @returns A binding named `bun-environment` that serves HTTP APIs and returns the validated values.
 * @throws {HolqaError} `HOLQA_CONFIG_INVALID`, one diagnostic per invalid entry. Secret values and the schema's messages about them are never included.
 */
export async function createEnvironmentBinding(app: AppDescriptor, env: EnvironmentVariables): Promise<RuntimeBinding> {
  const values = new Map<string, unknown>();
  const problems: Diagnostic[] = [];
  for (const entry of app.config) {
    const raw = env[entry.name];
    const candidate: unknown = raw ?? entry.defaultValue;
    try {
      values.set(entry.name, await validateInput(entry.schema, candidate, `configuration value ${entry.name}`));
    } catch (error) {
      if (!(error instanceof InputValidationError))
        throw error;
      const missing = candidate === undefined;
      const kind = entry.sensitive ? "secret" : "variable";
      problems.push(createDiagnostic({
        code: diagnosticCodes.configInvalid,
        severity: "error",
        message: missing
          ? `The ${kind} ${entry.name} is required but not set.`
          : entry.sensitive
            ? `The secret ${entry.name} does not satisfy its schema.`
            : `The variable ${entry.name} does not satisfy its schema: ${error.issues.map(issue => issue.message).join("; ")}`,
        hint: `Set the environment variable ${entry.name} before starting the application.`,
        details: { name: entry.name, kind, missing }
      }));
    }
  }
  if (problems.length > 0)
    throw new HolqaError(problems);
  return Object.freeze({
    name: "bun-environment",
    capabilities: Object.freeze({ "http.api": Object.freeze({}) }),
    drivers: Object.freeze({}),
    config: (entry: ConfigDescriptor) => values.get(entry.name)
  });
}