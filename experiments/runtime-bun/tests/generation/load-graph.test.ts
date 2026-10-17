import { join } from "node:path";
import {
  afterAll,
  describe,
  expect,
  it
} from "bun:test";

import {
  checkSyntax,
  discoverHandlerModules,
  evictModuleCache,
  importGraph
} from "@/generation/load-graph";

import {
  copyFixture,
  removeFixtureCopies,
  setFixtureVersion,
  writeFixtureFile
} from "../support/fixture";

afterAll(() => removeFixtureCopies());

describe("load-graph", () => {
  it("discovers handler modules in sorted order", async () => {
    const root = copyFixture("basic");
    expect(await discoverHandlerModules(root, ["./handlers/**/*.handler.ts"])).toEqual([
      "handlers/echo.handler.ts",
      "handlers/gated.handler.ts",
      "handlers/jobs.handler.ts",
      "handlers/uploads.handler.ts"
    ]);
  });

  it("reports files that do not parse without importing them", async () => {
    const root = copyFixture("basic");
    writeFixtureFile(root, "shared/broken.ts", "export const value = {;\n");
    const diagnostics = await checkSyntax(root);
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.location?.file])).toEqual([["HOLQA_MODULE_EVALUATION_FAILED", "shared/broken.ts"]]);
  });

  it("shows that a query-string import re-evaluates only the entry, while eviction refreshes the whole graph", async () => {
    const root = copyFixture("basic");
    const echo = join(root, "handlers/echo.handler.ts");
    const state = join(root, "state.ts");
    const first = await import(state) as { readonly version: string };
    setFixtureVersion(root, "v2");
    await import(`${echo}?bust=1`);
    expect((await import(state) as { readonly version: string }).version).toBe(first.version);
    expect(evictModuleCache(root)).toBeGreaterThan(0);
    expect((await import(state) as { readonly version: string }).version).toBe("v2");
  });

  it("turns Bun's never-settling re-import of a module that failed to parse into a diagnostic", async () => {
    const root = copyFixture("basic");
    // Without the syntax pre-check, the first handler's import of the broken
    // module rejects and the second handler's import of it never settles.
    writeFixtureFile(root, "state.ts", "export const version = {;\n");
    const graph = await importGraph(root, "infra.ts", { timeoutMs: 100 });
    expect(graph.ok).toBe(false);
    if (graph.ok)
      return;
    expect(graph.error.map(diagnostic => diagnostic.location?.file)).toEqual(["handlers/echo.handler.ts", "handlers/gated.handler.ts"]);
    expect(graph.error[1]?.message).toContain("did not settle");
  });

  it("rejects an entry that does not default-export an application", async () => {
    const root = copyFixture("basic");
    writeFixtureFile(root, "other.ts", "export const nothing = 1;\n");
    const graph = await importGraph(root, "other.ts");
    expect(graph.ok ? "ok" : graph.error[0]?.code).toBe("HOLQA_DECLARATION_INVALID");
  });
});