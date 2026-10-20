import type { ValidatedHandler } from "@holqa/bindings";

import {
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBindingManifest,
  inspectBindings,
  resolveBindings
} from "@holqa/bindings";
import { diagnosticsOf } from "@holqa/core";
import { silentSink } from "@holqa/runtime-bun";
import app from "@test/support/app";
import { bindings } from "@test/support/bindings";
import * as handlerModule from "@test/support/handlers";

import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import {
  artifactFormat,
  sha256Hex
} from "@/artifact";
import { startContainer } from "@/start";

const handlers = [handlerModule.hello, handlerModule.enqueue, handlerModule.work];

/** The handlers as the application manifest lists them. */
const manifestHandlers = [
  { id: "enqueue", trigger: { kind: "http.route", resource: { kind: "http.api", id: "api" }, options: {} } },
  { id: "hello", trigger: { kind: "http.route", resource: { kind: "http.api", id: "api" }, options: {} } },
  { id: "jobs.work", trigger: { kind: "queue.message", resource: { kind: "queue", id: "jobs" }, options: {} } }
] as unknown as ValidatedHandler[];

const fingerprint = `sha256:${"b".repeat(64)}`;
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/**
 * Writes an artifact directory as `holqa package` would, for the given binding configuration.
 *
 * @param name - The binding configuration's name recorded in bindings.json.
 * @returns The directory.
 */
async function writeArtifact(name = "container-test"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "holqa-artifact-"));
  directories.push(directory);
  const files: Record<string, string> = {
    "server.js": "// bundled entry point\n",
    "manifest.json": `${JSON.stringify({ application: { name: "shop" }, handlers: manifestHandlers })}\n`,
    "bindings.json": `${JSON.stringify(createBindingManifest(inspectBindings(resolveBindings(bindings(name)), { handlers: manifestHandlers }), { applicationManifest: fingerprint }))}\n`
  };
  for (const [path, content] of Object.entries(files))
    await writeFile(join(directory, path), content);
  const listed = Object.entries(files).map(([path, content]) => ({ path, sha256: sha256Hex(new TextEncoder().encode(content)), bytes: new TextEncoder().encode(content).length })).sort((left, right) => left.path < right.path ? -1 : 1);
  await writeFile(join(directory, "artifact.json"), JSON.stringify({ format: artifactFormat, application: "shop", manifest: fingerprint, bindings: name, entry: "server.js", runtime: { bun: "1.3.0" }, staticSites: [], files: listed }));
  return directory;
}

/**
 * Collects the diagnostic codes a start fails with.
 *
 * @param start - The start attempt.
 * @returns The codes.
 */
async function failure(start: Promise<unknown>): Promise<string[]> {
  try {
    await start;
  } catch (error) {
    return diagnosticsOf(error).map(diagnostic => diagnostic.code);
  }
  return [];
}

const env = { PORT: "0", HOST: "127.0.0.1", HOLQA_SHUTDOWN_GRACE_MS: "2000" };

describe("startContainer", () => {
  it("serves HTTP, static files and probes, runs background handlers and drains on stop", async () => {
    const running = await startContainer({ app, handlers, bindings: bindings(), env, log: silentSink, signals: false });
    try {
      expect(await (await fetch(new URL("/api/hello", running.url))).json()).toEqual({ hello: "world" });
      expect((await fetch(new URL("/api/jobs/first", running.url), { method: "POST" })).status).toBe(202);
      for (let attempt = 0; attempt < 200 && !handlerModule.processed.includes("first"); attempt++)
        await Bun.sleep(10);
      expect(handlerModule.processed).toContain("first");
      expect(await (await fetch(new URL("/", running.url))).text()).toContain("<p>web</p>");
      expect(await (await fetch(new URL("/catalog/7", running.url))).text()).toContain("<p>web</p>");
      expect((await fetch(new URL("/.holqa/live", running.url))).status).toBe(200);
      const ready = await fetch(new URL("/.holqa/ready", running.url));
      expect([ready.status, (await ready.json() as { ready: boolean }).ready]).toEqual([200, true]);
    } finally {
      await running.stop();
    }
    expect(running.runtime.state).toBe("stopped");
  });

  it("starts a verified artifact whose binding matches the packaged binding manifest", async () => {
    const running = await startContainer({ app, handlers, bindings: bindings(), directory: await writeArtifact(), env, log: silentSink, signals: false });
    expect((await fetch(new URL("/api/hello", running.url))).status).toBe(200);
    await running.stop();
  });

  it("refuses a binding that differs from the packaged binding manifest", async () => {
    const directory = await writeArtifact("staging");
    expect(await failure(startContainer({ app, handlers, bindings: bindings("production"), directory, env, log: silentSink, signals: false }))).toEqual(["HOLQA_ARTIFACT_INVALID"]);
  });

  it("refuses an altered or incomplete artifact before starting anything", async () => {
    const changed = await writeArtifact();
    await writeFile(join(changed, "bindings.json"), "{}\n");
    expect(await failure(startContainer({ app, handlers, bindings: bindings(), directory: changed, env, log: silentSink, signals: false }))).toEqual(["HOLQA_ARTIFACT_INVALID"]);
    const missing = await writeArtifact();
    await rm(join(missing, "server.js"));
    expect(await failure(startContainer({ app, handlers, bindings: bindings(), directory: missing, env, log: silentSink, signals: false }))).toEqual(["HOLQA_ARTIFACT_INVALID"]);
  });

  it("refuses invalid settings and a configuration of another application", async () => {
    expect(await failure(startContainer({ app, handlers, bindings: bindings(), env: { PORT: "http" }, log: silentSink, signals: false }))).toEqual(["HOLQA_CONTAINER_SETTINGS_INVALID"]);
    expect(await failure(startContainer({ app, handlers, bindings: {}, env, log: silentSink, signals: false }))).toEqual(["HOLQA_BINDING_CONFIG_INVALID"]);
  });
});