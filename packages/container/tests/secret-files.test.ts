import type { ProviderContext } from "@holqa/core";

import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diagnosticsOf,
  validateProvider
} from "@holqa/core";

import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import { secretFiles } from "@/secret-files";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/**
 * Creates a secrets directory with files.
 *
 * @param files - File contents by name.
 * @returns The temporary directory's path, removed after the test.
 */
async function secretsDirectory(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "holqa-secrets-"));
  directories.push(directory);
  for (const [name, content] of Object.entries(files))
    await writeFile(join(directory, name), content);
  return directory;
}

describe("container.secretFiles", () => {
  it("reads one value per file, without the trailing newline, and ignores other entries", async () => {
    const directory = await secretsDirectory({ "API_TOKEN": "first-token\n", "QUEUE_URL": "amqp://broker", "..data": "ignored" });
    await mkdir(join(directory, "nested"));
    const provider = secretFiles({ directory });
    expect(validateProvider(provider)).toEqual([]);
    expect(provider.settings).toEqual({ configSource: "files", directory });
    const { config } = await provider.open({} as ProviderContext);
    expect([config!.lookup("API_TOKEN"), config!.lookup("QUEUE_URL"), config!.lookup("..data"), config!.lookup("nested")]).toEqual(["first-token", "amqp://broker", undefined, undefined]);
  });

  it("sees rotated values after refresh", async () => {
    const directory = await secretsDirectory({ API_TOKEN: "first-token" });
    const { config } = await secretFiles({ directory }).open({} as ProviderContext);
    await writeFile(join(directory, "API_TOKEN"), "rotated-token");
    expect(config!.lookup("API_TOKEN")).toBe("first-token");
    await config!.refresh!();
    expect(config!.lookup("API_TOKEN")).toBe("rotated-token");
  });

  it("fails clearly when the directory is missing", async () => {
    let codes: string[] = [];
    try {
      await secretFiles({ directory: join(tmpdir(), "holqa-no-such-secrets") }).open({} as ProviderContext);
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_BINDING_FAILED"]);
  });
});