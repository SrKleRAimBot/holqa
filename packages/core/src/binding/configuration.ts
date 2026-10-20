import type { ConfigDescriptor } from "@/config/config-descriptor";
import type { Diagnostic } from "@/diagnostics/diagnostic";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";
import { HolqaError } from "@/errors/holqa-error";
import {
  InputValidationError,
  validateInput
} from "@/schema/validate-input";

/** Settings of {@link resolveConfiguration}. */
export interface ResolveConfigurationOptions {
  /** How to supply a missing value, for the hint, for example `Set the environment variable` (the entry's name is appended). */
  readonly hint?: string;
}

/**
 * Resolves and validates every configuration entry of an application, the
 * same way for every source: a missing value falls back to the declared
 * default, and the value (or its absence) must satisfy the entry's schema.
 * Raw values usually arrive as strings, so schemas for other types should
 * coerce (for example `z.coerce.number()`).
 *
 * @param entries - The application's configuration entries.
 * @param lookup - Returns the raw value of an entry by name, or `undefined`.
 * @param options - How to word the hint.
 * @returns The validated values by entry name.
 * @throws {HolqaError} `HOLQA_CONFIG_INVALID`, one diagnostic per invalid entry. Secret values and the schema's messages about them are never included.
 */
export async function resolveConfiguration(entries: readonly ConfigDescriptor[], lookup: (name: string) => unknown, options: ResolveConfigurationOptions = {}): Promise<ReadonlyMap<string, unknown>> {
  const values = new Map<string, unknown>();
  const problems: Diagnostic[] = [];
  const hint = options.hint ?? "Set the environment variable";
  for (const entry of entries) {
    const candidate: unknown = lookup(entry.name) ?? entry.defaultValue;
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
        hint: `${hint} ${entry.name} before starting the application.`,
        details: { name: entry.name, kind, missing }
      }));
    }
  }
  if (problems.length > 0)
    throw new HolqaError(problems);
  return values;
}