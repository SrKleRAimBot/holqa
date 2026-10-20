// A small, dependency-free lexical scanner for TypeScript and JavaScript
// modules. It recognizes exactly what event analysis needs (identifiers,
// punctuators, string and template literals, numbers, regular expressions,
// comments) and pairs brackets. It is not a parser: anything it cannot scan
// reliably makes the module unavailable to analysis, which then reports its
// publications as unknown rather than guessing.

/** The kind of a scanned token. */
export type TokenKind = "identifier" | "punctuator" | "string" | "template" | "number" | "regex";

/** One token of a scanned module. */
export interface Token {
  readonly kind: TokenKind;
  /** The token's source text. For templates: the text of this part only. */
  readonly text: string;
  /**
   * For strings: the literal's value. For templates: the static text before
   * the first substitution (the head), or the whole literal when it has none.
   */
  readonly value?: string;
  /** For templates: whether `value` is the literal's whole value (no substitution). */
  readonly complete?: boolean;
  /** For templates: whether this token continues a literal after a substitution, rather than starting one. */
  readonly continuation?: boolean;
  /** Offset of the first character. */
  readonly start: number;
  /** 1-based line of the first character. */
  readonly line: number;
  /** 1-based column of the first character. */
  readonly column: number;
  /** Whether a line break separates this token from the previous one. */
  readonly newline: boolean;
}

/** A scanned module: its tokens and, for every bracket, the index of its partner. */
export interface ScannedSource {
  readonly tokens: readonly Token[];
  /** For each token index: the partner bracket's index, or -1 for tokens that are not brackets. */
  readonly partner: readonly number[];
  /** For each token index: how many brackets enclose it (a bracket counts as inside its parent, not itself). */
  readonly depth: readonly number[];
}

/** Punctuators, longest first, so that the scanner always takes the longest match. */
const punctuators = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ";",
  ",",
  "<",
  ">",
  "+",
  "-",
  "*",
  "%",
  "&",
  "|",
  "^",
  "!",
  "~",
  "?",
  ":",
  "=",
  ".",
  "@",
  "#"
];

/** Keywords after which a `/` starts a regular expression rather than a division. */
const regexKeywords = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/** Punctuators after which a `/` starts a regular expression. */
const regexAfter = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "=>", "&&", "||", "??", "==", "===", "!=", "!==", "<=", ">=", "+=", "-=", "*=", "%=", "...", "?."]);

/** Characters that may start an identifier. */
const identifierStart = /[\p{ID_Start}$_]/u;

/** Characters that may continue an identifier. */
const identifierPart = /[\p{ID_Continue}$\u200C\u200D]/u;

/** Thrown when the source cannot be scanned; the analysis then treats the module as unavailable. */
export class ScanError extends Error {}

/**
 * Scans a module's source text into tokens and pairs its brackets.
 *
 * @param text - The module's source.
 * @returns The tokens with bracket partners and depths.
 * @throws {ScanError} For unterminated literals or comments and for unbalanced brackets.
 */
export function scanSource(text: string): ScannedSource {
  const tokens = tokenize(text);
  const partner: number[] = Array.from<number>({ length: tokens.length }).fill(-1);
  const depth: number[] = Array.from<number>({ length: tokens.length }).fill(0);
  const open: number[] = [];
  const pairs: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
  for (const [index, token] of tokens.entries()) {
    depth[index] = open.length;
    if (token.kind !== "punctuator")
      continue;
    if (token.text === "(" || token.text === "[" || token.text === "{") {
      open.push(index);
      continue;
    }
    const expected = pairs[token.text];
    if (expected === undefined)
      continue;
    const opening = open.pop();
    if (opening === undefined || tokens[opening]!.text !== expected)
      throw new ScanError(`Unbalanced "${token.text}" at line ${token.line}.`);
    partner[opening] = index;
    partner[index] = opening;
    depth[index] = open.length;
  }
  if (open.length > 0)
    throw new ScanError(`Unclosed "${tokens[open.at(-1)!]!.text}" at line ${tokens[open.at(-1)!]!.line}.`);
  return { tokens, partner, depth };
}

/**
 * Splits source text into tokens, skipping whitespace and comments.
 *
 * @param text - The module's source.
 * @returns The tokens in source order.
 * @throws {ScanError} For unterminated literals and comments.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n")
      lineStarts.push(index + 1);
  }
  /**
   * Converts an offset into a 1-based line and column.
   *
   * @param offset - A character offset.
   * @returns The 1-based line and column.
   */
  const position = (offset: number): { readonly line: number; readonly column: number } => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset)
        low = middle;
      else
        high = middle - 1;
    }
    return { line: low + 1, column: offset - lineStarts[low]! + 1 };
  };
  /** Whether a line break was seen since the last token. */
  let newline = false;
  /** Brace contexts: `true` for a template substitution, `false` for a plain brace. */
  const braces: boolean[] = [];
  /**
   * Records a token.
   *
   * @param kind - Its kind.
   * @param start - Its first offset.
   * @param end - The offset after it.
   * @param extra - Its literal value and template flags.
   */
  const push = (kind: TokenKind, start: number, end: number, extra: Partial<Pick<Token, "value" | "complete" | "continuation">> = {}): void => {
    tokens.push({ kind, text: text.slice(start, end), start, ...position(start), newline: newline || tokens.length === 0, ...extra });
    newline = false;
  };
  /**
   * Scans template text from `start` (just after a backtick or a substitution's `}`).
   *
   * @param start - Where the template text begins.
   * @param from - Where the token begins (the backtick or the `}`).
   * @param continuation - Whether the part follows a substitution.
   * @returns The offset after the scanned part.
   */
  const template = (start: number, from: number, continuation: boolean): number => {
    let index = start;
    let value = "";
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\\") {
        value += unescape(text[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (char === "`") {
        push("template", from, index + 1, { value, complete: !continuation, continuation });
        return index + 1;
      }
      if (char === "$" && text[index + 1] === "{") {
        push("template", from, index + 2, { value, complete: false, continuation });
        braces.push(true);
        return index + 2;
      }
      if (char === "\n")
        newline = true;
      value += char;
      index++;
    }
    throw new ScanError("Unterminated template literal.");
  };

  let index = text.startsWith("#!") ? !text.includes("\n") ? text.length : text.indexOf("\n") : 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\n") {
      newline = true;
      index++;
      continue;
    }
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1)
        throw new ScanError("Unterminated comment.");
      if (text.slice(index, end).includes("\n"))
        newline = true;
      index = end + 2;
      continue;
    }
    if (char === "\"" || char === "'") {
      let end = index + 1;
      let value = "";
      while (end < text.length && text[end] !== char) {
        if (text[end] === "\n")
          throw new ScanError("Unterminated string literal.");
        if (text[end] === "\\") {
          value += unescape(text[end + 1] ?? "");
          end += 2;
          continue;
        }
        value += text[end];
        end++;
      }
      if (end >= text.length)
        throw new ScanError("Unterminated string literal.");
      push("string", index, end + 1, { value });
      index = end + 1;
      continue;
    }
    if (char === "`") {
      index = template(index + 1, index, false);
      continue;
    }
    if (char === "}" && braces.at(-1) === true) {
      braces.pop();
      index = template(index + 1, index, true);
      continue;
    }
    if (identifierStart.test(char) || char === "\\") {
      let end = index + 1;
      while (end < text.length && identifierPart.test(text[end]!))
        end++;
      push("identifier", index, end);
      index = end;
      continue;
    }
    if (/\d/.test(char) || (char === "." && /\d/.test(text[index + 1] ?? ""))) {
      let end = index + 1;
      while (end < text.length && /[\w.]/.test(text[end]!)) {
        // An exponent sign belongs to the number: 1e-3.
        if (/e/i.test(text[end]!) && /[+-]/.test(text[end + 1] ?? "") && !/^0x/i.test(text.slice(index, end)))
          end++;
        end++;
      }
      push("number", index, end);
      index = end;
      continue;
    }
    if (char === "/" && startsRegex(tokens.at(-1))) {
      let end = index + 1;
      let inClass = false;
      while (end < text.length) {
        const current = text[end]!;
        if (current === "\n")
          throw new ScanError("Unterminated regular expression.");
        if (current === "\\") {
          end += 2;
          continue;
        }
        if (current === "[")
          inClass = true;
        else if (current === "]")
          inClass = false;
        else if (current === "/" && !inClass)
          break;
        end++;
      }
      if (end >= text.length)
        throw new ScanError("Unterminated regular expression.");
      end++;
      while (end < text.length && /[a-z]/i.test(text[end]!))
        end++;
      push("regex", index, end);
      index = end;
      continue;
    }
    const punctuator = punctuators.find(candidate => text.startsWith(candidate, index)) ?? (char === "/" ? "/" : undefined);
    if (punctuator === undefined) {
      // Anything else (JSX text, unusual characters) is skipped as one character.
      index++;
      continue;
    }
    const resolved = punctuator === "/" && text[index + 1] === "=" ? "/=" : punctuator;
    if (resolved === "{")
      braces.push(false);
    else if (resolved === "}")
      braces.pop();
    push("punctuator", index, index + resolved.length);
    index += resolved.length;
  }
  return tokens;
}

/**
 * Decides whether a `/` after a token starts a regular expression.
 *
 * @param previous - The token before the `/`, if any.
 * @returns `true` when a regular expression is expected there.
 */
function startsRegex(previous: Token | undefined): boolean {
  if (previous === undefined)
    return true;
  if (previous.kind === "punctuator")
    return regexAfter.has(previous.text);
  if (previous.kind === "identifier")
    return regexKeywords.has(previous.text);
  return false;
}

/**
 * Converts the character after a backslash into the character it stands for.
 * Only what analysis compares needs to be exact (keys and identifiers);
 * unusual escapes keep their letter.
 *
 * @param char - The escaped character.
 * @returns Its value.
 */
function unescape(char: string): string {
  switch (char) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    default:
      return char;
  }
}