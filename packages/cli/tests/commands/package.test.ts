import type { CliHost } from "@/analysis/host";

import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterAll,
  describe,
  expect,
  it,
  setDefaultTimeout
} from "bun:test";

import { createProcessHost } from "@/analysis/process-host";
import { runCli } from "@/run";

// Packaging spawns an analysis process and bundles; running spawns the artifact.
setDefaultTimeout(60_000);

/** The executable search path, passed on so the analysis process can start. */
const { PATH } = process.env;

/** The fixture application packaged here. */
const root = join(import.meta.dir, "..", "fixtures", "apps", "packaged");
const directories: string[] = [];

afterAll(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});

/**
 * Creates an empty temporary directory, removed after the tests.
 *
 * @returns Its path.
 */
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "holqa-package-"));
  directories.push(directory);
  return directory;
}

/**
 * Runs the CLI against the fixture with a process host.
 *
 * @param argv - The arguments.
 * @returns The exit code and output.
 */
async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const host: CliHost = createProcessHost({ cwd: root, environment: { PATH } });
  const code = await runCli(argv, { stdout: text => stdout.push(text), stderr: text => stderr.push(text) }, "1.2.3", host);
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

/** One file of artifact.json. */
interface ListedFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Reads an artifact's descriptor.
 *
 * @param directory - The artifact directory.
 * @returns The parsed artifact.json.
 */
async function descriptorOf(directory: string): Promise<{ readonly format: string; readonly application: string; readonly bindings: string; readonly entry: string; readonly staticSites: unknown; readonly files: readonly ListedFile[] }> {
  return JSON.parse(await readFile(join(directory, "artifact.json"), "utf8")) as never;
}

/**
 * Starts a packaged artifact with Bun, as its Dockerfile does, and waits until it serves.
 *
 * @param directory - Where `holqa package` wrote the artifact.
 * @returns The process and the URL it serves on.
 */
async function startArtifact(directory: string): Promise<{ readonly process: Bun.Subprocess<"ignore", "pipe", "pipe">; readonly url: URL }> {
  const child = Bun.spawn([process.execPath, "server.js"], { cwd: directory, env: { PATH, PORT: "0", HOST: "127.0.0.1", HOLQA_SHUTDOWN_GRACE_MS: "2000" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done)
      throw new Error(`The artifact exited before serving: ${await new Response(child.stderr).text()}`);
    buffered += new TextDecoder().decode(value);
    const line = buffered.split("\n").find(candidate => candidate.includes("\"container serving\""));
    if (line !== undefined) {
      reader.releaseLock();
      return { process: child, url: new URL((JSON.parse(line) as { readonly url: string }).url) };
    }
  }
}

describe("holqa package", () => {
  it("writes a verified, runnable artifact: bundle, manifests, static files, Dockerfile and hashes", async () => {
    const outDir = await temporary();
    const { code, stdout } = await run(["package", "--out-dir", outDir, "--json"]);
    expect(code).toBe(0);
    const output = JSON.parse(stdout) as { readonly artifact: { readonly fingerprint: string; readonly application: string; readonly bindings: string; readonly entry: string }; readonly diagnostics: unknown[] };
    expect(output.artifact).toMatchObject({ application: "packaged", bindings: "production", entry: "server.js" });
    expect(output.artifact.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const descriptor = await descriptorOf(outDir);
    expect(descriptor.format).toBe("holqa.artifact/1");
    expect(descriptor.staticSites).toEqual([{ id: "web", directory: "web" }]);
    expect(descriptor.files.map(file => file.path)).toEqual(["Dockerfile", "bindings.json", "manifest.json", "server.js", "web/index.html"]);
    const bindings = JSON.parse(await readFile(join(outDir, "bindings.json"), "utf8")) as { readonly format: string; readonly resources: ReadonlyArray<{ readonly id: string; readonly provider: string }> };
    expect(bindings.format).toBe("holqa.binding-manifest/1");
    expect(bindings.resources.map(resource => [resource.id, resource.provider])).toEqual([["api", "container"], ["jobs", "local"], ["web", "container"]]);
    expect(await readFile(join(outDir, "Dockerfile"), "utf8")).toContain(`FROM oven/bun:${Bun.version}-slim`);

    const { process: child, url } = await startArtifact(outDir);
    try {
      expect(await (await fetch(new URL("/api/hello", url))).json()).toEqual({ hello: "packaged" });
      expect(await (await fetch(new URL("/", url))).text()).toContain("packaged web");
      expect((await fetch(new URL("/.holqa/ready", url))).status).toBe(200);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await child.exited).toBe(0);
  });

  it("produces the same files and hashes for the same inputs", async () => {
    const [first, second] = [await temporary(), await temporary()];
    expect((await run(["package", "--out-dir", first])).code).toBe(0);
    expect((await run(["package", "--out-dir", second])).code).toBe(0);
    expect((await descriptorOf(first)).files).toEqual((await descriptorOf(second)).files);
  });

  it("refuses to start an altered artifact", async () => {
    const outDir = await temporary();
    expect((await run(["package", "--out-dir", outDir])).code).toBe(0);
    await writeFile(join(outDir, "web", "index.html"), "<p>defaced</p>");
    const child = Bun.spawn([process.execPath, "server.js"], { cwd: outDir, env: { PATH, PORT: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    const failure = JSON.parse(await new Response(child.stderr).text()) as { readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly details?: { readonly file?: string } }> };
    expect(failure.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.details?.file])).toEqual([["HOLQA_ARTIFACT_INVALID", "web/index.html"]]);
  });

  it("writes nothing for an invalid binding configuration, and never replaces a directory it did not write", async () => {
    const outDir = await temporary();
    const invalid = await run(["package", "--bindings", "bindings-invalid.ts", "--out-dir", outDir, "--json"]);
    expect(invalid.code).toBe(1);
    expect((JSON.parse(invalid.stderr) as { readonly diagnostics: ReadonlyArray<{ readonly code: string }> }).diagnostics.map(diagnostic => diagnostic.code)).toContain("HOLQA_BINDING_MISSING");
    await writeFile(join(outDir, "notes.txt"), "keep me");
    const occupied = await run(["package", "--out-dir", outDir, "--json"]);
    expect(occupied.code).toBe(1);
    expect((JSON.parse(occupied.stderr) as { readonly diagnostics: ReadonlyArray<{ readonly code: string }> }).diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_PACKAGE_FAILED"]);
    expect(await readFile(join(outDir, "notes.txt"), "utf8")).toBe("keep me");
  });
});