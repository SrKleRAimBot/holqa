import {
  describe,
  expect,
  it
} from "bun:test";

import { parseOptions } from "@/arguments";

describe("parseOptions", () => {
  const spec = { flags: ["manifest"], values: ["app", "out-dir"] };

  it("reads flags and values in both spellings", () => {
    const parsed = parseOptions(["--manifest", "--app", "apps/infra.ts", "--out-dir=dist"], spec);
    expect(parsed.ok && [...parsed.flags]).toEqual(["manifest"]);
    expect(parsed.ok && Object.fromEntries(parsed.values)).toEqual({ "app": "apps/infra.ts", "out-dir": "dist" });
  });

  it.each([
    [["extra"], "Unexpected argument \"extra\"."],
    [["--watch"], "Unknown option \"--watch\"."],
    [["--app"], "The option \"--app\" requires a value."],
    [["--app", "--manifest"], "The option \"--app\" requires a value."],
    [["--app="], "The option \"--app\" requires a value."],
    [["--manifest=yes"], "The option \"--manifest\" takes no value."],
    [["--app", "a", "--app", "b"], "The option \"--app\" is given more than once."]
  ])("rejects %p", (args, problem) => {
    expect(parseOptions(args, spec)).toEqual({ ok: false, problems: [problem] });
  });

  it("reads exactly the positional arguments a command requires", () => {
    const withPositionals = { flags: [], values: ["data"], positionals: ["queue"] };
    expect(parseOptions(["orders", "--data", "{}"], withPositionals)).toEqual({ ok: true, flags: new Set(), values: new Map([["data", "{}"]]), positionals: ["orders"] });
    expect(parseOptions(["--data", "{}"], withPositionals)).toEqual({ ok: false, problems: ["The argument <queue> is missing."] });
    expect(parseOptions(["orders", "more"], withPositionals)).toEqual({ ok: false, problems: ["Unexpected argument \"more\"."] });
    expect(parseOptions(["--", "--odd-name"], withPositionals)).toMatchObject({ ok: true, positionals: ["--odd-name"] });
  });
});