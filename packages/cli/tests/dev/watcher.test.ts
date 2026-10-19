import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  isEnvironmentFile,
  isWatchedFile,
  snapshotFiles,
  watchFiles
} from "@/dev/watcher";

describe("isWatchedFile", () => {
  it.each([
    ["infra.ts", true],
    ["src/orders.handler.ts", true],
    ["src/data.json", true],
    [".env", true],
    [".env.local", true],
    ["README.md", false],
    ["src/.env", false],
    [".holqa/dev/build/manifest.json", false],
    [".git/index", false],
    ["node_modules/zod/index.js", false],
    ["", false]
  ])("%p -> %p", (path, watched) => {
    expect(isWatchedFile(path)).toBe(watched);
  });

  it("recognizes environment files only in the root", () => {
    expect(isEnvironmentFile(".env.production")).toBe(true);
    expect(isEnvironmentFile("config/.env")).toBe(false);
    expect(isEnvironmentFile("env.ts")).toBe(false);
  });
});

describe("snapshotFiles", () => {
  it("records watched files and skips ignored files and directories", () => {
    const root = mkdtempSync(join(tmpdir(), "holqa-snapshot-"));
    try {
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, ".holqa"));
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "infra.ts"), "export {};");
      writeFileSync(join(root, ".env"), "A=1");
      writeFileSync(join(root, "README.md"), "ignored");
      writeFileSync(join(root, "src", "a.handler.ts"), "export {};");
      writeFileSync(join(root, ".holqa", "state.json"), "{}");
      writeFileSync(join(root, "node_modules", "index.js"), "");
      const snapshot = snapshotFiles(root);
      expect([...snapshot.keys()].sort()).toEqual([".env", "infra.ts", "src/a.handler.ts"]);
      writeFileSync(join(root, "infra.ts"), "export const changed = true;");
      expect(snapshotFiles(root).get("infra.ts")).not.toBe(snapshot.get("infra.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns nothing for a directory that does not exist", () => {
    expect(snapshotFiles(join(tmpdir(), "holqa-missing-directory")).size).toBe(0);
  });
});

describe("watchFiles", () => {
  it("reports one batch of relevant changes after they stop arriving", async () => {
    const root = mkdtempSync(join(tmpdir(), "holqa-watch-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".holqa"));
    const batches: Array<readonly string[]> = [];
    const stop = watchFiles({ root, debounceMs: 100, onChange: files => batches.push(files) });
    try {
      await Bun.sleep(100);
      // The ignored files come first: Bun on Linux may report only the first of these events,
      // and the source changes must not be lost behind it.
      writeFileSync(join(root, "notes.md"), "ignored");
      writeFileSync(join(root, ".holqa", "state.json"), "{}");
      writeFileSync(join(root, "src", "a.handler.ts"), "export {};");
      writeFileSync(join(root, "infra.ts"), "export {};");
      // Operating systems may split or repeat events; assert on everything reported, not on batch boundaries.
      /**
       * Collects every path reported so far.
       *
       * @returns The paths of all batches.
       */
      const seen = (): Set<string> => new Set(batches.flat());
      for (let round = 0; round < 150 && !(seen().has("infra.ts") && seen().has("src/a.handler.ts")); round += 1)
        await Bun.sleep(20);
      await Bun.sleep(250);
      expect([...seen()].sort()).toEqual(["infra.ts", "src/a.handler.ts"]);
      expect(batches.every(batch => batch.length > 0 && [...batch].sort().join() === batch.join())).toBe(true);
    } finally {
      stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("reports a removed file", async () => {
    const root = mkdtempSync(join(tmpdir(), "holqa-watch-"));
    writeFileSync(join(root, "infra.ts"), "export {};");
    const batches: Array<readonly string[]> = [];
    const stop = watchFiles({ root, debounceMs: 50, onChange: files => batches.push(files) });
    try {
      await Bun.sleep(100);
      rmSync(join(root, "infra.ts"));
      for (let round = 0; round < 150 && batches.length === 0; round += 1)
        await Bun.sleep(20);
      expect(batches.flat()).toContain("infra.ts");
    } finally {
      stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});