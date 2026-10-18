import type {
  ApplicationScope,
  ScopedDefinition
} from "@holqa/core";

import {
  DeclarationProblems,
  requireOptions
} from "@/internal/declaration";

/**
 * Options accepted by {@link scoped}.
 *
 * @typeParam Value - What `create` returns.
 */
export interface ScopedOptions<Value> {
  /** A short name used in logs and diagnostics, for example `database`. */
  readonly name: string;
  /** Creates the value the first time an invocation uses it in an execution context. */
  readonly create: (scope: ApplicationScope) => Value | Promise<Value>;
  /** Releases the value when the execution context stops. */
  readonly dispose?: (value: Value) => void | Promise<void>;
}

/**
 * Declares an application-scoped value, such as a connection pool, that the
 * runtime creates once per application execution context and disposes of when
 * that context stops. Handlers and middleware obtain it with
 * `await scope.use(definition)`; it is never shared across separately started
 * runtimes. Pure: nothing is created when it is declared.
 *
 * @example
 * ```ts
 * export const database = scoped({
 *   name: "database",
 *   create: () => createPool(app.env.DATABASE_URL),
 *   dispose: pool => pool.end()
 * });
 * ```
 *
 * @param options - The name and how to create and dispose of the value.
 * @returns A frozen definition; the object itself identifies the value.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when the name is empty or `create` or `dispose` is not a function.
 */
export function scoped<Value>(options: ScopedOptions<Value>): ScopedDefinition<Value> {
  const raw = requireOptions(options, "scoped");
  const problems = new DeclarationProblems(`scoped value "${String(raw.name)}"`);
  if (typeof raw.name !== "string" || raw.name.trim() === "")
    problems.invalid("\"name\" must be a non-empty string.");
  if (typeof raw.create !== "function")
    problems.invalid("\"create\" must be a function.");
  if (raw.dispose !== undefined && typeof raw.dispose !== "function")
    problems.invalid("\"dispose\" must be a function.");
  problems.throwIfAny();
  return Object.freeze({ name: options.name, create: options.create, ...options.dispose === undefined ? {} : { dispose: options.dispose } });
}