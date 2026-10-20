import type { EntrypointMap } from "@holqa/compiler";
import type { ScratchApp } from "@test/support/scratch-app";
import type { ManifestChange } from "@/dev/classify";
import type { ReloadInput } from "@/dev/reload-plan";

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { scratchApp } from "@test/support/scratch-app";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "bun:test";

import { buildModuleGraph } from "@/dev/module-graph";
import {
  planReload,
  sharedModules
} from "@/dev/reload-plan";

/** No identity changes. */
const none = { added: [], removed: [], changed: [] };

/**
 * Builds a manifest change of one kind.
 *
 * @param kind - What changed.
 * @returns A change without identity changes or contract diagnostics.
 */
function changeOf(kind: ManifestChange["kind"]): ManifestChange {
  return { kind, resources: none, handlers: none, config: none, contracts: [] };
}

/** The entry point map of the fixture: `a` and `b` share `src/common.ts`, `c` stands alone. */
const entrypoints = {
  format: "holqa.entrypoints/1",
  manifest: "sha256:0",
  application: { module: "infra.ts", export: "default" },
  handlers: [
    { id: "a", module: "src/a.handler.ts", export: "a" },
    { id: "b", module: "src/b.handler.ts", export: "b" },
    { id: "c", module: "src/c.handler.ts", export: "c" },
    { id: "d", module: "src/d.handler.ts", export: "d" }
  ]
} as unknown as EntrypointMap;

/** The application of this suite. */
let app: ScratchApp;
/** The input every test starts from. */
let base: ReloadInput;

beforeAll(() => {
  app = scratchApp({
    "infra.ts": "import { config } from \"./src/config\";\nexport default config;\n",
    "src/config.ts": "export const config = 1;\n",
    "src/common.ts": "export const common = new Map();\n",
    "src/a.handler.ts": "import app from \"../infra\";\nimport { common } from \"./common\";\nimport { onlyA } from \"./only-a\";\nexport const a = [app, common, onlyA];\n",
    "src/only-a.ts": "export const onlyA = 1;\n",
    "src/b.handler.ts": "import { common } from \"./common\";\nexport const b = common;\n",
    "src/c.handler.ts": "import { config } from \"./config\";\nexport const c = config;\n",
    "src/d.handler.ts": "// holqa:restart-on-change\nexport const d = 1;\n",
    "scripts/seed.ts": "export {};\n"
  });
  const graph = buildModuleGraph(app.root, ["infra.ts", ...entrypoints.handlers.map(entry => entry.module)].map(module => join(app.root, module)));
  base = { files: [], change: changeOf("implementation"), hot: true, serving: true, previous: entrypoints, next: entrypoints, graph, swaps: 0, maxSwaps: 50 };
});

afterAll(() => app.remove());

describe("planReload", () => {
  it("swaps a handler module and every handler module that shares an application module with it", () => {
    expect(planReload({ ...base, files: ["src/only-a.ts"] })).toEqual({ strategy: "swap", modules: ["src/a.handler.ts", "src/b.handler.ts"], handlers: ["a", "b"] });
  });

  it("swaps only the changed module when it shares nothing", () => {
    expect(planReload({ ...base, files: ["src/b.handler.ts"] })).toMatchObject({ strategy: "swap" });
    expect(planReload({ ...base, files: ["src/c.handler.ts"] })).toEqual({ strategy: "swap", modules: ["src/c.handler.ts"], handlers: ["c"] });
  });

  it.each([
    ["the first build", { change: changeOf("initial"), files: ["infra.ts"] }, "initial"],
    ["a reload without files", { files: [] }, "requested"],
    ["hot replacement turned off", { hot: false, files: ["src/c.handler.ts"] }, "hot-disabled"],
    ["no serving generation", { serving: false, files: ["src/c.handler.ts"] }, "no-generation"],
    ["environment files", { change: changeOf("environment"), files: [".env"] }, "environment"],
    ["a dependency manifest", { files: ["package.json"] }, "dependencies"],
    ["a compiler configuration", { files: ["tsconfig.json"] }, "dependencies"],
    ["changed resources", { change: changeOf("resources"), files: ["src/c.handler.ts"] }, "contract"],
    ["changed handlers", { change: changeOf("handlers"), files: ["src/c.handler.ts"] }, "contract"],
    ["a moved handler", { next: { ...entrypoints, handlers: entrypoints.handlers.map(entry => entry.id === "c" ? { ...entry, export: "renamed" } : entry) } as unknown as EntrypointMap, files: ["src/c.handler.ts"] }, "entrypoints"],
    ["an import of the application module", { files: ["src/config.ts"] }, "application-module"],
    ["the application module", { files: ["infra.ts"] }, "application-module"],
    ["a file no handler imports", { files: ["scripts/seed.ts"] }, "unreferenced-module"],
    ["a module marked for restarts", { files: ["src/d.handler.ts"] }, "restart-marker"],
    ["the replacement limit", { swaps: 50, files: ["src/c.handler.ts"] }, "swap-limit"],
    ["the binding configuration", { bindingsModule: "bindings.ts", files: ["bindings.ts"] }, "bindings"]
  ] as const)("restarts for %s", (_name, overrides, reason) => {
    expect(planReload({ ...base, ...overrides } as ReloadInput)).toMatchObject({ strategy: "restart", reason });
  });

  it("lists the application module and its imports as shared modules", () => {
    const root = realpathSync(app.root);
    expect(sharedModules(base.graph!, "infra.ts")).toEqual([join(root, "infra.ts"), join(root, "src/config.ts")]);
  });
});