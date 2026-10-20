import type { ScratchApp } from "@test/support/scratch-app";

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

import {
  buildModuleGraph,
  reachable
} from "@/dev/module-graph";

/** The application of this suite. */
let app: ScratchApp;
/** Its real root. */
let root: string;

beforeAll(() => {
  app = scratchApp({
    "infra.ts": "import { shared } from \"./src/shared\";\nexport default shared;\n",
    "src/shared.ts": "export const shared = 1;\n",
    "src/helper.ts": "// holqa:restart-on-change\nexport const helper = 2;\n",
    "src/a.handler.ts": "import app from \"../infra\";\nimport type { Unused } from \"./types\";\nimport { helper } from \"./helper\";\nimport { describe } from \"bun:test\";\nexport const a = [app, helper, describe];\n",
    "src/types.ts": "export type Unused = string;\n",
    "src/broken.handler.ts": "export const = ;\n"
  });
  root = realpathSync(app.root);
});

afterAll(() => app.remove());

describe("buildModuleGraph", () => {
  it("follows application imports, skips packages and type-only imports, and records restart markers", () => {
    const graph = buildModuleGraph(app.root, [join(app.root, "infra.ts"), join(app.root, "src/a.handler.ts")]);
    expect([...graph.imports.get(join(root, "src/a.handler.ts"))!].sort()).toEqual([join(root, "infra.ts"), join(root, "src/helper.ts")]);
    expect([...graph.marked]).toEqual([join(root, "src/helper.ts")]);
    expect([...reachable(graph, join(root, "src/a.handler.ts"), new Set([join(root, "infra.ts")]))].sort()).toEqual([join(root, "src/a.handler.ts"), join(root, "src/helper.ts")]);
  });

  it("records modules it cannot read or parse instead of failing", () => {
    const graph = buildModuleGraph(app.root, [join(app.root, "src/broken.handler.ts"), join(app.root, "src/missing.ts")]);
    expect([...graph.unreadable].sort()).toEqual([join(root, "src/broken.handler.ts"), join(app.root, "src/missing.ts")].sort());
  });
});