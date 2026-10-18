import {
  describe,
  expect,
  it
} from "bun:test";

import { selectHandlerModules } from "@/discovery/select-handler-modules";

describe("selectHandlerModules", () => {
  const files = ["src/z.handler.ts", "src\\orders\\a.handler.ts", "src/orders/a.test.ts", "infra.ts", "src/b.handler.ts"];

  it("selects matching modules, sorted, whatever the listing order", () => {
    const forward = selectHandlerModules(files, { include: ["src/**/*.handler.ts"], exclude: [] }, "infra.ts");
    const backward = selectHandlerModules([...files].reverse(), { include: ["src/**/*.handler.ts"], exclude: [] }, "infra.ts");
    expect(forward.modules).toEqual(["src/b.handler.ts", "src/orders/a.handler.ts", "src/z.handler.ts"]);
    expect(backward).toEqual(forward);
    expect(forward.diagnostics).toEqual([]);
  });

  it("applies exclusions after inclusions and merges overlapping patterns", () => {
    const selection = selectHandlerModules(files, { include: ["src/**/*.ts", "src/*.handler.ts"], exclude: ["**/*.test.ts", "src/z.*"] }, "infra.ts");
    expect(selection.modules).toEqual(["src/b.handler.ts", "src/orders/a.handler.ts"]);
  });

  it("warns about include patterns that match nothing", () => {
    const selection = selectHandlerModules(files, { include: ["handlers/*.ts"], exclude: [] }, "infra.ts");
    expect(selection.modules).toEqual([]);
    expect(selection.diagnostics).toEqual([expect.objectContaining({ code: "HOLQA_HANDLER_PATTERN_UNMATCHED", severity: "warning", location: { file: "infra.ts" }, details: { pattern: "handlers/*.ts" } })]);
  });

  it("rejects patterns and files outside the application root", () => {
    const selection = selectHandlerModules(["/etc/passwd", "src/a.ts"], { include: ["../*.ts", "src/*.ts"], exclude: [] }, "infra.ts");
    expect(selection.modules).toEqual(["src/a.ts"]);
    expect(selection.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_DECLARATION_INVALID", "HOLQA_DECLARATION_INVALID"]);
  });
});