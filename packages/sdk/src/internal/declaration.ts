import type {
  Diagnostic,
  JsonValue,
  ResourceId
} from "@holqa/core";

import {
  createDiagnostic,
  diagnosticCodes,
  HolqaError,
  isStandardSchema,
  parseResourceId
} from "@holqa/core";

/**
 * Collects every problem in one declaration so that a single error reports all
 * of them, instead of making the developer fix them one run at a time.
 */
export class DeclarationProblems {
  /** The diagnostics collected so far. */
  readonly #diagnostics: Diagnostic[] = [];

  /** What is being declared, prefixed to every message. */
  private readonly subject: string;

  /**
   * Creates a collector for one declaration.
   *
   * @param subject - What is being declared, prefixed to every message (for example `queue "orders"`).
   */
  constructor(subject: string) {
    this.subject = subject;
  }

  /**
   * Records a `HOLQA_DECLARATION_INVALID` problem.
   *
   * @param message - What is wrong, without the subject.
   * @param hint - Optional, actionable guidance.
   */
  invalid(message: string, hint?: string): void {
    this.#diagnostics.push(createDiagnostic({
      code: diagnosticCodes.declarationInvalid,
      severity: "error",
      message: `${this.subject}: ${message}`,
      ...(hint === undefined ? {} : { hint })
    }));
  }

  /**
   * Records already-built diagnostics, such as identifier problems.
   *
   * @param diagnostics - The diagnostics to record.
   */
  add(diagnostics: readonly Diagnostic[]): void {
    this.#diagnostics.push(...diagnostics);
  }

  /**
   * Validates an identifier against the resource identifier grammar.
   *
   * @param id - The declared identifier, unvalidated.
   * @param label - Where it was declared, for messages.
   * @returns The parsed identifier, or `undefined` after recording a `HOLQA_RESOURCE_ID_INVALID` problem.
   */
  identifier(id: unknown, label: string): ResourceId | undefined {
    const parsed = parseResourceId(id);
    if (parsed.ok)
      return parsed.value;
    this.#diagnostics.push(createDiagnostic({ ...parsed.error, message: `${label}: ${parsed.error.message}` }));
    return undefined;
  }

  /**
   * Checks that a value implements Standard Schema v1.
   *
   * @param schema - The candidate schema.
   * @param role - The option that supplied it, for messages.
   */
  schema(schema: unknown, role: string): void {
    if (!isStandardSchema(schema))
      this.invalid(`"${role}" is not a Standard Schema.`, "Use a schema library that implements Standard Schema v1, such as Zod 4 or Valibot 1, or implement the interface yourself.");
  }

  /**
   * Checks that an optional value is a positive safe integer.
   *
   * @param value - The candidate value.
   * @param option - The option name, for messages.
   */
  positiveInteger(value: unknown, option: string): void {
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1))
      this.invalid(`"${option}" must be a positive integer.`);
  }

  /**
   * Checks that a value is one of a fixed set of strings.
   *
   * @param value - The candidate value.
   * @param allowed - The accepted values.
   * @param option - The option name, for messages.
   */
  oneOf(value: unknown, allowed: readonly string[], option: string): void {
    if (typeof value !== "string" || !allowed.includes(value))
      this.invalid(`"${option}" must be one of ${allowed.map(entry => `"${entry}"`).join(", ")}.`);
  }

  /**
   * Throws when any problem was recorded.
   *
   * @throws {HolqaError} With every recorded diagnostic.
   */
  throwIfAny(): void {
    if (this.#diagnostics.length > 0)
      throw new HolqaError(this.#diagnostics);
  }

  /**
   * Throws when any problem was recorded, and otherwise returns a value that
   * validation produced, such as a parsed identifier.
   *
   * @param value - The validated value; `undefined` only when a problem was recorded.
   * @returns The value.
   * @throws {HolqaError} With every recorded diagnostic.
   */
  valid<Value>(value: Value | undefined): Value {
    this.throwIfAny();
    if (value === undefined)
      throw new TypeError(`${this.subject}: a validated value is missing although no problem was recorded.`);
    return value;
  }
}

/**
 * The shape of a declaration argument before it is validated: the expected
 * keys, each of unknown type, because types are erased at run time.
 *
 * @typeParam Options - The declared options type.
 */
export type Untrusted<Options> = { readonly [Key in keyof Options]?: unknown };

/**
 * Reads an options argument defensively: JavaScript callers and casts can pass anything.
 *
 * @param value - The argument.
 * @param subject - What is being declared, for the error message.
 * @returns The argument with every property typed as `unknown`.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when the argument is not an object.
 */
export function requireOptions<Options>(value: Options, subject: string): Untrusted<Options> {
  if (typeof value !== "object" || value === null) {
    const problems = new DeclarationProblems(subject);
    problems.invalid("expected an options object.");
    problems.throwIfAny();
  }
  return value as Untrusted<Options>;
}

/**
 * Reads an optional nested options object defensively.
 *
 * @param value - The nested value, possibly `undefined`.
 * @param option - The option name, for messages.
 * @param problems - Where to record a malformed value.
 * @returns The nested object with unknown property types, or an empty object when absent or malformed.
 */
export function optionalObject<Options>(value: unknown, option: string, problems: DeclarationProblems): Untrusted<Options> {
  if (value === undefined)
    return {};
  if (typeof value !== "object" || value === null) {
    problems.invalid(`"${option}" must be an object.`);
    return {};
  }
  return value as Untrusted<Options>;
}

/**
 * Freezes plain JSON data recursively. Descriptors are shared between the
 * SDK, compiler and runtime, so their data must not change after declaration.
 *
 * @param value - JSON data built by the SDK (never user-owned objects such as schemas).
 * @returns The same value, frozen at every depth.
 */
export function freezeJson<Value extends JsonValue | object>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value))
      freezeJson(entry as JsonValue);
    Object.freeze(value);
  }
  return value;
}

/**
 * Copies only the entries whose value is defined, so optional settings are
 * omitted rather than stored as `undefined` (which is not JSON).
 *
 * @param entries - Candidate entries.
 * @returns A new object without `undefined` values.
 */
export function definedEntries<Entries extends object>(entries: Entries): { [Key in keyof Entries]?: Exclude<Entries[Key], undefined> } {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined)
      result[key] = value;
  }
  return result as { [Key in keyof Entries]?: Exclude<Entries[Key], undefined> };
}