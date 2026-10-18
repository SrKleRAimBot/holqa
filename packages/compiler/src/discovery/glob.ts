/**
 * A compiled handler discovery pattern.
 */
export interface GlobMatcher {
  /** The pattern as written, after removing a leading `./`. */
  readonly pattern: string;
  /**
   * Reports whether a portable, root-relative path matches the pattern.
   *
   * @param path - A path such as `src/orders/process.handler.ts`.
   * @returns `true` when the whole path matches.
   */
  readonly matches: (path: string) => boolean;
}

/**
 * Compiles a glob pattern into a matcher with one fixed, host-independent
 * meaning, so that discovery selects the same modules on every machine:
 *
 * - `*` matches any characters within one path segment (never `/`);
 * - `?` matches one character within a segment;
 * - `**` as a whole segment matches zero or more segments;
 * - `{a,b}` matches any one of the comma-separated alternatives (not nested);
 * - every other character, including `[` and `]`, matches itself.
 *
 * Matching is case-sensitive and dot files are not treated specially.
 *
 * @param pattern - A pattern relative to the application root, for example `src/**\/*.handler.ts`.
 * @returns The matcher.
 *
 * @example
 * ```ts
 * compileGlob("src/**\/*.handler.ts").matches("src/orders/process.handler.ts"); // true
 * ```
 */
export function compileGlob(pattern: string): GlobMatcher {
  const normalized = pattern.replace(/^(?:\.\/)+/, "");
  const segments = normalized.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**")
      source += last ? ".*" : "(?:[^/]+/)*";
    else
      source += segmentSource(segment) + (last ? "" : "/");
  });
  const expression = new RegExp(`^${source}$`);
  return { pattern: normalized, matches: path => expression.test(path) };
}

/**
 * Translates one path segment of a glob into a regular-expression source.
 *
 * @param segment - The segment, without `/`.
 * @returns The equivalent regular-expression source.
 */
function segmentSource(segment: string): string {
  let source = "";
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index]!;
    if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "{") {
      const end = segment.indexOf("}", index);
      if (end === -1) {
        source += escapeRegExp(character);
        continue;
      }
      const alternatives = segment.slice(index + 1, end).split(",");
      source += `(?:${alternatives.map(segmentSource).join("|")})`;
      index = end;
    } else {
      source += escapeRegExp(character);
    }
  }
  return source;
}

/**
 * Escapes a character so that a regular expression matches it literally.
 *
 * @param text - The text to escape.
 * @returns The escaped text.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}