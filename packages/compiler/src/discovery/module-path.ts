/**
 * Normalizes a host-supplied module path into the portable form the compiler
 * records: relative to the application root, `/` separators, no leading `./`.
 * Absolute paths, drive letters and `..` segments are rejected because they
 * would make output depend on the machine or escape the application.
 *
 * @param path - The path as supplied by the host, for example `src\\orders.ts` or `./infra.ts`.
 * @returns The portable path, or `undefined` when the path is absolute, empty or escapes the root.
 */
export function portableModulePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/{2,}/g, "/");
  if (normalized === "" || normalized.startsWith("/") || /^[a-z]:/i.test(normalized))
    return undefined;
  const segments = normalized.split("/");
  if (segments.includes("..") || segments.includes(".") || segments.includes(""))
    return undefined;
  return normalized;
}

/**
 * Compares two strings by UTF-16 code units, the order every sorted list in
 * compiler output uses. Unlike `localeCompare`, the result never depends on
 * the host's locale.
 *
 * @param left - The first string.
 * @param right - The second string.
 * @returns A negative number, zero or a positive number, like `Array.prototype.sort` expects.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}