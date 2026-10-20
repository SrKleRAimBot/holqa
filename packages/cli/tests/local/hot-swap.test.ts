import type { Runtime } from "@holqa/runtime-bun";
import type { ScratchApp } from "@test/support/scratch-app";

import {
  createDiagnostic,
  getHandlerDescriptor,
  HolqaError
} from "@holqa/core";
import { scratchApp } from "@test/support/scratch-app";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import { HotSwapper } from "@/local/hot-swap";

/** Applications created by a test, removed afterwards. */
const apps: ScratchApp[] = [];

afterEach(() => {
  for (const app of apps.splice(0))
    app.remove();
});

/**
 * Creates a swapper for a scratch application with one handler module, and a
 * runtime stub that records the registrations it receives.
 *
 * @param handlerModule - The source of `src/run.handler.ts`.
 * @param reject - Makes the runtime refuse the replacement.
 * @returns The swapper and what the runtime received.
 */
function setup(handlerModule: string, reject = false): { readonly swapper: HotSwapper; readonly received: unknown[][] } {
  const app = scratchApp({ "infra.ts": "export default {};\n", "src/run.handler.ts": handlerModule });
  apps.push(app);
  const received: unknown[][] = [];
  const runtime = {
    replaceHandlers: (registrations: readonly unknown[]) => {
      received.push([...registrations]);
      if (reject)
        throw new HolqaError(createDiagnostic({ code: "HOLQA_HANDLER_REPLACEMENT_INVALID", severity: "error", message: "definition changed" }));
      return { version: 2, handlers: ["nightly.run"] };
    },
    handlerVersions: () => [{ handlerId: "nightly.run", version: 2, active: 0, retiring: [] }]
  } as unknown as Runtime;
  const swapper = new HotSwapper({ root: app.root, outDir: `${app.root}/.holqa/dev/hot/1`, handlers: [{ id: "nightly.run", module: "src/run.handler.ts", export: "run" }], runtime });
  return { swapper, received };
}

/** The request every test sends. */
const request = { modules: ["src/run.handler.ts"], shared: [] };

/** A valid handler module. */
const validModule = "import { tick } from \"@test/support/descriptors\";\n\nexport const run = tick(\"nightly.run\", \"nightly\", () => \"new\");\n";

describe("HotSwapper", () => {
  it("installs the handlers of a rebuilt module", async () => {
    const { swapper, received } = setup(validModule);
    const outcome = await swapper.swap(request);
    expect(outcome).toMatchObject({ ok: true, version: 2, handlers: ["nightly.run"], versions: [{ handlerId: "nightly.run", version: 2 }] });
    expect(String(getHandlerDescriptor(received[0]![0])?.definition.id)).toBe("nightly.run");
    swapper.dispose();
  });

  it("keeps the running code when the new code does not build, with the error's location", async () => {
    const { swapper, received } = setup("export const run = ;\n");
    const outcome = await swapper.swap(request);
    expect(outcome).toMatchObject({ ok: false, restart: false, diagnostics: [{ code: "HOLQA_MODULE_EVALUATION_FAILED", location: { file: "src/run.handler.ts", line: 1, column: 20 } }] });
    expect(received).toEqual([]);
  });

  it("keeps the running code when the new code throws while loading", async () => {
    const { swapper, received } = setup("throw new Error(\"broken on load\");\n");
    const outcome = await swapper.swap(request);
    expect(outcome).toMatchObject({ ok: false, restart: false, diagnostics: [{ code: "HOLQA_MODULE_EVALUATION_FAILED" }] });
    expect(received).toEqual([]);
  });

  it("refuses modules with top-level side effects and asks for a restart", async () => {
    const before = process.listenerCount("beforeExit");
    const { swapper, received } = setup(`${validModule}process.on("beforeExit", () => {});\n`);
    const outcome = await swapper.swap(request);
    expect(outcome).toMatchObject({ ok: false, restart: true, reason: "side-effects", diagnostics: [{ code: "HOLQA_RELOAD_FAILED", severity: "info" }] });
    expect(received).toEqual([]);
    // The listener the module added while loading was removed again.
    expect(process.listenerCount("beforeExit")).toBe(before);
  });

  it("asks for a restart for modules with top-level await, which cannot be evaluated in place", async () => {
    const { swapper, received } = setup(`await Promise.resolve();\n${validModule}`);
    expect(await swapper.swap(request)).toMatchObject({ ok: false, restart: true, reason: "side-effects" });
    expect(received).toEqual([]);
  });

  it("asks for a restart when the runtime refuses the replacement", async () => {
    const { swapper } = setup(validModule, true);
    expect(await swapper.swap(request)).toMatchObject({ ok: false, restart: true, reason: "replacement-rejected", diagnostics: [{ code: "HOLQA_HANDLER_REPLACEMENT_INVALID" }] });
  });
});