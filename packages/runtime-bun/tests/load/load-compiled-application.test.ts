import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diagnosticsOf } from "@holqa/core";
import {
  afterAll,
  describe,
  expect,
  it
} from "bun:test";

import {
  createRuntime,
  loadCompiledApplication,
  silentSink
} from "@/index";

/** Scratch directories removed after the run. */
const scratch = mkdtempSync(join(tmpdir(), "holqa-runtime-load-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** An application module with plain descriptors, so the fixture needs no packages. */
const infraSource = `
export default {
  "~holqa": {
    protocol: 1, type: "app", name: "shop", handlers: { include: ["src/*.handler.ts"], exclude: [] },
    resources: [{ protocol: 1, type: "resource", kind: "http.api", id: "api", config: { basePath: "/api" }, requirements: {}, schemas: {} }],
    config: [],
    binding: Object.seal({ current: undefined })
  }
};`;

/**
 * A handler module exporting one route.
 *
 * @param path - The route's path.
 * @returns The module source.
 */
function handlerSource(path: string): string {
  return `
export const hello = {
  "~holqa": {
    protocol: 1, type: "handler",
    definition: { id: "hello", trigger: { kind: "http.route", resource: { kind: "http.api", id: "api" }, options: { method: "GET", path: "${path}" } } },
    schemas: { responses: {} },
    invoke: async () => new Response("hello from a compiled app")
  }
};`;
}

/** The manifest the fixture was "compiled" to; only the parts the loader reads. */
const manifest = {
  manifestVersion: 1,
  application: { name: "shop" },
  resources: [{ id: "api", kind: "http.api", config: { basePath: "/api" }, requirements: {} }],
  config: [],
  handlers: [{ id: "hello", trigger: { kind: "http.route", resource: { kind: "http.api", id: "api" }, options: { method: "GET", path: "/hello" } } }]
};

/**
 * Computes a manifest fingerprint the way the compiler does.
 *
 * @param text - The manifest text without its trailing newline.
 * @returns The `sha256:` fingerprint.
 */
async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Writes a fixture application and its build output into a fresh directory.
 *
 * @param options - What to vary.
 * @param options.routePath - The path the handler module declares now.
 * @param options.fingerprintOf - Overrides the manifest fingerprint the entry point map records.
 * @param options.exportName - The export the entry point map names.
 * @returns The application root.
 */
async function writeApp(options: { readonly routePath?: string; readonly fingerprintOf?: string; readonly exportName?: string } = {}): Promise<string> {
  const root = mkdtempSync(join(scratch, "app-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".holqa", "build"), { recursive: true });
  writeFileSync(join(root, "infra.ts"), infraSource);
  writeFileSync(join(root, "src", "hello.handler.ts"), handlerSource(options.routePath ?? "/hello"));
  const manifestText = JSON.stringify(manifest, null, 2);
  writeFileSync(join(root, ".holqa", "build", "manifest.json"), `${manifestText}\n`);
  writeFileSync(join(root, ".holqa", "build", "entrypoints.json"), `${JSON.stringify({
    format: "holqa.entrypoints/1",
    manifest: options.fingerprintOf ?? await fingerprint(manifestText),
    application: { module: "infra.ts", handlers: { include: ["src/*.handler.ts"], exclude: [] } },
    handlers: [{ id: "hello", module: "src/hello.handler.ts", export: options.exportName ?? "hello", exports: ["hello"] }]
  })}\n`);
  return root;
}

/**
 * Collects the diagnostic codes of a rejected load.
 *
 * @param root - The application root.
 * @returns The diagnostic codes, or an empty list when the load succeeds.
 */
async function loadCodes(root: string): Promise<string[]> {
  return loadCompiledApplication({ root }).then(() => [], (error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
}

describe("loadCompiledApplication", () => {
  it("loads the application and handlers named by the build output, ready to run", async () => {
    const compiled = await loadCompiledApplication({ root: await writeApp() });
    expect(compiled.handlers).toHaveLength(1);
    expect(compiled.manifestFingerprint).toStartWith("sha256:");
    expect(compiled.handlerSources).toEqual({ hello: "src/hello.handler.ts#hello" });
    const runtime = createRuntime({ ...compiled, env: {}, log: silentSink });
    await runtime.start();
    expect(await (await runtime.fetch(new Request("http://localhost/api/hello"))).text()).toBe("hello from a compiled app");
    await runtime.stop();
  });

  it("rejects build output that no longer matches the code", async () => {
    expect(await loadCodes(await writeApp({ routePath: "/renamed" }))).toEqual(["HOLQA_BUILD_STALE"]);
    expect(await loadCodes(await writeApp({ exportName: "goodbye" }))).toEqual(["HOLQA_BUILD_STALE"]);
    expect(await loadCodes(await writeApp({ fingerprintOf: `sha256:${"0".repeat(64)}` }))).toEqual(["HOLQA_BUILD_STALE"]);
  });

  it("detects changed resource settings and configuration", async () => {
    const changedBase = await writeApp();
    writeFileSync(join(changedBase, "infra.ts"), infraSource.replace("basePath: \"/api\"", "basePath: \"/v2\""));
    expect(await loadCodes(changedBase)).toEqual(["HOLQA_BUILD_STALE"]);
    const changedConfig = await writeApp();
    writeFileSync(join(changedConfig, "infra.ts"), infraSource.replace("config: [],", "config: [{ protocol: 1, type: \"config\", name: \"TOKEN\", sensitive: true, schema: { \"~standard\": { version: 1, vendor: \"t\", validate: value => ({ value }) } } }],"));
    expect(await loadCodes(changedConfig)).toEqual(["HOLQA_BUILD_STALE"]);
    const renamed = await writeApp();
    writeFileSync(join(renamed, "infra.ts"), infraSource.replace("name: \"shop\"", "name: \"store\""));
    expect(await loadCodes(renamed)).toEqual(["HOLQA_BUILD_STALE"]);
  });

  it("rejects other manifest versions and modules that are not applications", async () => {
    const otherVersion = await writeApp();
    const manifestPath = join(otherVersion, ".holqa", "build", "manifest.json");
    writeFileSync(manifestPath, (await Bun.file(manifestPath).text()).replace("\"manifestVersion\": 1", "\"manifestVersion\": 2"));
    expect(await loadCodes(otherVersion)).toEqual(["HOLQA_MANIFEST_VERSION_UNSUPPORTED"]);
    const notAnApp = await writeApp();
    writeFileSync(join(notAnApp, "infra.ts"), "export default { name: \"shop\" };");
    expect(await loadCodes(notAnApp)).toEqual(["HOLQA_APP_INVALID"]);
  });

  it("reports missing and malformed build output", async () => {
    expect(await loadCodes(mkdtempSync(join(scratch, "empty-")))).toEqual(["HOLQA_APP_NOT_FOUND"]);
    const root = await writeApp();
    writeFileSync(join(root, ".holqa", "build", "entrypoints.json"), "{");
    expect(await loadCodes(root)).toEqual(["HOLQA_MANIFEST_INVALID"]);
    writeFileSync(join(root, ".holqa", "build", "entrypoints.json"), JSON.stringify({ format: "holqa.entrypoints/1", manifest: "x", application: { module: "../outside.ts" }, handlers: [] }));
    expect(await loadCodes(root)).toEqual(["HOLQA_MANIFEST_INVALID"]);
  });

  it("reports a module that throws while loading", async () => {
    const root = await writeApp();
    writeFileSync(join(root, "infra.ts"), "throw new Error(\"boom\");");
    expect(await loadCodes(root)).toEqual(["HOLQA_MODULE_EVALUATION_FAILED"]);
  });
});