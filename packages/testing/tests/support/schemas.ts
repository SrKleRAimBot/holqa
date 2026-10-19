import type { StandardSchemaV1 } from "@holqa/core";

/**
 * Builds a Standard Schema for objects with the given string properties, so
 * tests need no schema library.
 *
 * @param keys - The required string properties.
 * @returns A schema that accepts objects with exactly those string properties.
 */
export function stringRecord<const Keys extends string>(...keys: Keys[]): StandardSchemaV1<{ readonly [Key in Keys]: string }> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value))
          return { issues: [{ message: "Expected an object." }] };
        const record = value as Record<string, unknown>;
        const issues = keys.filter(key => typeof record[key] !== "string").map(key => ({ message: `Expected a string.`, path: [key] }));
        if (Object.keys(record).some(key => !keys.includes(key as Keys)))
          issues.push({ message: "Unexpected property.", path: [] });
        return issues.length > 0 ? { issues } : { value: value as { readonly [Key in Keys]: string } };
      }
    }
  };
}