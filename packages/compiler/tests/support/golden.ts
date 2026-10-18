import {
  readFileSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import { expect } from "bun:test";

/** Directory holding golden files, relative to this module. */
const fixtures = join(import.meta.dir, "..", "fixtures");

/**
 * Compares text with a committed golden file. Set `HOLQA_UPDATE_GOLDEN=1` to
 * rewrite the file instead, then review the diff before committing.
 *
 * @param name - The file name under `tests/fixtures/`.
 * @param text - The produced text, without a trailing newline.
 */
export function expectGolden(name: string, text: string): void {
  const path = join(fixtures, name);
  const { HOLQA_UPDATE_GOLDEN: update } = process.env;
  if (update === "1")
    writeFileSync(path, `${text}\n`);
  expect(`${text}\n`).toBe(readFileSync(path, "utf8"));
}