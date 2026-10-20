import {
  describe,
  expect,
  it
} from "bun:test";

import {
  ScanError,
  scanSource
} from "@/events/source-scanner";

/**
 * Scans text and returns each token's kind and text.
 *
 * @param text - Source text.
 * @returns `kind:text` per token.
 */
function kinds(text: string): string[] {
  return scanSource(text).tokens.map(token => `${token.kind}:${token.text}`);
}

describe("scanSource", () => {
  it("skips comments and whitespace and records positions", () => {
    const { tokens } = scanSource("// note\nconst a = 1; /* block\n */ a?.b");
    expect(tokens.map(token => token.text)).toEqual(["const", "a", "=", "1", ";", "a", "?.", "b"]);
    expect(tokens[0]).toMatchObject({ line: 2, column: 1, newline: true });
    expect(tokens[5]).toMatchObject({ line: 3, column: 5, newline: true });
  });

  it("reads string values and template heads, with substitutions scanned as code", () => {
    const { tokens } = scanSource(`put(\`incoming/${["$", "{key}"].join("")}.json\`, "a\\"b")`);
    const template = tokens.find(token => token.kind === "template")!;
    expect(template).toMatchObject({ value: "incoming/", complete: false, continuation: false });
    expect(tokens.map(token => token.text)).toContain("key");
    expect(tokens.find(token => token.kind === "template" && token.continuation === true)?.value).toBe(".json");
    expect(tokens.find(token => token.kind === "string")?.value).toBe("a\"b");
    expect(scanSource("`plain`").tokens[0]).toMatchObject({ kind: "template", value: "plain", complete: true });
  });

  it("tells regular expressions from divisions", () => {
    expect(kinds("x = a / b / c")).toEqual(["identifier:x", "punctuator:=", "identifier:a", "punctuator:/", "identifier:b", "punctuator:/", "identifier:c"]);
    expect(kinds("x = /a\\/[/]b/gi.test(y)")[2]).toBe("regex:/a\\/[/]b/gi");
    expect(kinds("return /x/")[1]).toBe("regex:/x/");
  });

  it("keeps braces inside template substitutions balanced", () => {
    const { tokens, partner } = scanSource(`f(\`${["$", "{ { a: 1 }.a }"].join("")}\`)`);
    const open = tokens.findIndex(token => token.text === "(");
    expect(tokens[partner[open]!]!.text).toBe(")");
  });

  it("pairs brackets and records their depth", () => {
    const { tokens, partner, depth } = scanSource("a({ b: [c] })");
    expect(partner[1]).toBe(tokens.length - 1);
    expect(depth[tokens.findIndex(token => token.text === "c")]).toBe(3);
  });

  it.each(["f(", "f)", "\"open", "`open", "/* open", "a = /open"])("rejects %p", (text) => {
    expect(() => scanSource(text)).toThrow(ScanError);
  });
});