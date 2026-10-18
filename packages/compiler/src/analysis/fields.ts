/**
 * Reads untrusted descriptor fields and records every problem as a sentence.
 * Descriptors come from evaluated user code, possibly written by another SDK
 * version or by hand, so the compiler re-checks what it copies into the
 * manifest and never copies a field it does not know.
 */
export class FieldReader {
  /** Problems found so far, in reading order. */
  readonly problems: string[] = [];

  /**
   * Reads a plain object and reports keys outside `known`, so that unknown
   * settings (such as a provider configuration bag) are rejected instead of
   * being dropped or passed through.
   *
   * @param value - The candidate object.
   * @param path - Its name in messages, for example `config`.
   * @param known - The keys the object may have.
   * @returns The object, or an empty object when `value` is not a plain object.
   */
  object<const Key extends string>(value: unknown, path: string, known: readonly Key[]): { readonly [Name in Key]?: unknown } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.problems.push(`"${path}" must be an object.`);
      return {};
    }
    for (const key of Object.keys(value).sort()) {
      if (!(known as readonly string[]).includes(key))
        this.problems.push(`"${path}.${key}" is not a recognized setting.`);
    }
    // Only own properties count: inherited ones are neither checked above nor copied.
    return Object.fromEntries(Object.entries(value).filter(([key]) => (known as readonly string[]).includes(key))) as { readonly [Name in Key]?: unknown };
  }

  /**
   * Reads a required positive safe integer.
   *
   * @param value - The candidate number.
   * @param path - Its name in messages.
   * @returns The number, or `1` after recording a problem.
   */
  positiveInteger(value: unknown, path: string): number {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1)
      return value;
    this.problems.push(`"${path}" must be a positive integer.`);
    return 1;
  }

  /**
   * Reads an optional positive safe integer.
   *
   * @param value - The candidate number, or `undefined`.
   * @param path - Its name in messages.
   * @returns The number, or `undefined` when absent or invalid.
   */
  optionalPositiveInteger(value: unknown, path: string): number | undefined {
    if (value === undefined)
      return undefined;
    return this.positiveInteger(value, path);
  }

  /**
   * Reads a required finite number that is not negative.
   *
   * @param value - The candidate number.
   * @param path - Its name in messages.
   * @returns The number, or `0` after recording a problem.
   */
  nonNegativeNumber(value: unknown, path: string): number {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value;
    this.problems.push(`"${path}" must be a number of at least 0.`);
    return 0;
  }

  /**
   * Reads a required boolean.
   *
   * @param value - The candidate boolean.
   * @param path - Its name in messages.
   * @returns The boolean, or `false` after recording a problem.
   */
  boolean(value: unknown, path: string): boolean {
    if (typeof value === "boolean")
      return value;
    this.problems.push(`"${path}" must be a boolean.`);
    return false;
  }

  /**
   * Reads a required string that satisfies an optional pattern.
   *
   * @param value - The candidate string.
   * @param path - Its name in messages.
   * @param pattern - A pattern the string must match, with a description of it.
   * @param pattern.expression - The regular expression.
   * @param pattern.description - What the expression requires, for messages.
   * @returns The string, or an empty string after recording a problem.
   */
  string(value: unknown, path: string, pattern?: { readonly expression: RegExp; readonly description: string }): string {
    if (typeof value === "string" && (pattern === undefined ? value.length > 0 : pattern.expression.test(value)))
      return value;
    this.problems.push(`"${path}" must be ${pattern?.description ?? "a non-empty string"}.`);
    return "";
  }

  /**
   * Reads an optional string.
   *
   * @param value - The candidate string, or `undefined`.
   * @param path - Its name in messages.
   * @returns The string, or `undefined` when absent or invalid.
   */
  optionalString(value: unknown, path: string): string | undefined {
    if (value === undefined)
      return undefined;
    if (typeof value === "string")
      return value;
    this.problems.push(`"${path}" must be a string.`);
    return undefined;
  }

  /**
   * Reads a value that must be one of a fixed set.
   *
   * @param value - The candidate value.
   * @param path - Its name in messages.
   * @param allowed - The allowed values; the first is returned after a problem.
   * @returns The value, or `allowed[0]` after recording a problem.
   */
  oneOf<Value extends string>(value: unknown, path: string, allowed: readonly [Value, ...Value[]]): Value {
    if (typeof value === "string" && (allowed as readonly string[]).includes(value))
      return value as Value;
    this.problems.push(`"${path}" must be one of ${allowed.map(entry => `"${entry}"`).join(", ")}.`);
    return allowed[0];
  }
}

/**
 * Returns a copy of an object without its `undefined` entries, so optional
 * settings are omitted from output rather than written as `undefined`.
 *
 * @param entries - The object to copy.
 * @returns A new object with only defined entries.
 */
export function definedEntries<Entries extends Record<string, unknown>>(entries: Entries): { [Key in keyof Entries]?: Exclude<Entries[Key], undefined> } {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as { [Key in keyof Entries]?: Exclude<Entries[Key], undefined> };
}