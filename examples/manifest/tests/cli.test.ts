import type { Manifest } from "@holqa/compiler";

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  join
} from "node:path";

import { validateManifest } from "@holqa/compiler";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout
} from "bun:test";

// Every test runs the built CLI, which spawns an analysis process; allow for slow machines.
setDefaultTimeout(60_000);

/** This example's directory. */
const example = join(import.meta.dir, "..");

/** The built `holqa` binary, through the CLI package's public files. */
const bin = join(dirname(Bun.resolveSync("@holqa/cli/package.json", example)), "dist", "bin.js");

/** Scratch directories removed after the run. */
const scratch = mkdtempSync(join(tmpdir(), "holqa-manifest-example-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Runs the built CLI in a separate process.
 *
 * @param args - The CLI arguments.
 * @param cwd - The working directory; defaults to this example.
 * @param env - Extra environment variables for the CLI process.
 * @returns The exit code and both output streams.
 */
function holqa(args: readonly string[], cwd = example, env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", bin, ...args], { cwd, env: { ...process.env, ...env } });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/**
 * Builds an application's manifest into a fresh directory.
 *
 * @param app - The application module, relative to `cwd`.
 * @param cwd - The working directory.
 * @returns The manifest and entry point map texts.
 */
function build(app: string, cwd = example): { manifest: string; entrypoints: string } {
  const out = mkdtempSync(join(scratch, "build-"));
  const result = holqa(["build", "--manifest", "--app", app, "--out-dir", out, "--json"], cwd);
  if (result.code !== 0)
    throw new Error(result.stderr);
  return { manifest: readFileSync(join(out, "manifest.json"), "utf8"), entrypoints: readFileSync(join(out, "entrypoints.json"), "utf8") };
}

describe("holqa build --manifest", () => {
  let shop = { manifest: "", entrypoints: "" };

  beforeAll(() => {
    shop = build("apps/shop/infra.ts");
  });

  it("writes the golden manifest, which the compiler's reader accepts", () => {
    const golden = join(example, "expected", "shop.manifest.json");
    const { HOLQA_UPDATE_GOLDEN: update } = process.env;
    if (update === "1")
      writeFileSync(golden, shop.manifest);
    expect(shop.manifest).toBe(readFileSync(golden, "utf8"));
    expect(validateManifest(JSON.parse(shop.manifest)).ok).toBe(true);
  });

  it("produces identical bytes in separate processes, from another directory and from a relocated copy", () => {
    expect(build("apps/shop/infra.ts").manifest).toBe(shop.manifest);
    expect(build("examples/manifest/apps/shop/infra.ts", join(example, "..", "..")).manifest).toBe(shop.manifest);

    const copy = mkdtempSync(join(scratch, "relocated-"));
    cpSync(join(example, "apps", "shop"), join(copy, "apps", "shop"), { recursive: true });
    writeFileSync(join(copy, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }));
    symlinkSync(join(example, "node_modules"), join(copy, "node_modules"), "dir");
    const relocated = build(join(copy, "apps", "shop", "infra.ts"));
    expect(relocated.manifest).toBe(shop.manifest);
    expect(relocated.entrypoints).toBe(shop.entrypoints);
  });

  it("records no machine-specific path", () => {
    for (const text of [shop.manifest, shop.entrypoints]) {
      expect(text).not.toContain(example);
      expect(text).not.toContain(tmpdir());
    }
    const { application, handlers } = JSON.parse(shop.entrypoints) as { application: { module: string }; handlers: Array<{ module: string }> };
    for (const module of [application.module, ...handlers.map(handler => handler.module)])
      expect(module).toMatch(/^[\w.-]+(?:\/[\w.-]+)*$/);
  });

  it("keeps the manifest when variables, aliases, files and exports are renamed but ids are kept", () => {
    const renamed = build("apps/shop-renamed/infra.ts");
    expect(renamed.manifest).toBe(shop.manifest);
    expect(renamed.entrypoints).not.toBe(shop.entrypoints);
    expect(JSON.parse(renamed.entrypoints)).toMatchObject({ handlers: expect.arrayContaining([{ id: "orders.process", module: "src/workers/fulfilment.ts", export: "fulfilOrders", exports: ["fulfilOrders"] }]) });
  });
});

describe("holqa inspect", () => {
  it("describes the intended infrastructure as JSON without secret values", () => {
    const result = holqa(["inspect", "--app", "apps/shop/infra.ts", "--json"], example, { DATABASE_URL: "postgres://shop:hunter2@db.internal/shop" });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("hunter2");
    expect(result.stderr).not.toContain("hunter2");
    const { manifest, graph } = JSON.parse(result.stdout) as { manifest: Manifest; graph: { edges: Array<{ from: string; to: string; relation: string }> } };
    expect(manifest.resources.map(resource => `${resource.kind} ${resource.id}`)).toEqual(["bucket catalog-images", "queue catalog-reindex", "schedule nightly-report", "queue order-placed", "http.api shop-api"]);
    expect(manifest.config).toEqual([
      expect.objectContaining({ name: "DATABASE_URL", kind: "secret" }),
      expect.objectContaining({ name: "LOG_LEVEL", kind: "variable", default: "info" })
    ]);
    expect(graph.edges.filter(edge => edge.relation === "triggers").map(edge => `${edge.from} -> ${edge.to}`)).toEqual([
      "resource:catalog-images -> handler:catalog.thumbnail",
      "resource:catalog-reindex -> handler:catalog.reindex",
      "resource:nightly-report -> handler:reports.nightly",
      "resource:order-placed -> handler:orders.process"
    ]);
  });

  it("rejects invalid references, duplicate handlers and top-level configuration access with actionable diagnostics", () => {
    const result = holqa(["inspect", "--app", "apps/invalid/infra.ts", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const { diagnostics } = JSON.parse(result.stderr) as { diagnostics: Array<{ code: string; location?: { file: string; line?: number }; hint?: string; details?: Record<string, unknown> }> };
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.location?.file, diagnostic.location?.line])).toEqual([
      ["HOLQA_RESOURCE_NOT_FOUND", "apps/invalid/src/refund.handler.ts", 4],
      ["HOLQA_MODULE_EVALUATION_FAILED", "apps/invalid/src/report.handler.ts", undefined],
      ["HOLQA_HANDLER_ID_DUPLICATE", "apps/invalid/src/settle.handler.ts", 4]
    ]);
    expect(diagnostics.every(diagnostic => diagnostic.hint !== undefined)).toBe(true);
    expect(diagnostics[1]?.details).toEqual({ module: "src/report.handler.ts", cause: "HOLQA_RUNTIME_NOT_BOUND" });
  });

  it("reports a missing application module", () => {
    const result = holqa(["inspect", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ diagnostics: [{ code: "HOLQA_APP_NOT_FOUND" }] });
  });
});