import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  canonicalJsonStringify,
  entrypointsJsonSchema,
  manifestJsonSchema
} from "@/index";

/** The published schema files, which must equal the exported constants. */
const files = {
  "manifest-v1.schema.json": manifestJsonSchema,
  "entrypoints-v1.schema.json": entrypointsJsonSchema
};

describe("published JSON Schemas", () => {
  it.each(Object.entries(files))("keeps schemas/%s in sync with the exported constant", (name, schema) => {
    const path = join(import.meta.dir, "..", "..", "schemas", name);
    const { HOLQA_UPDATE_GOLDEN: update } = process.env;
    if (update === "1")
      Bun.write(path, `${canonicalJsonStringify(schema)}\n`);
    expect(readFileSync(path, "utf8")).toBe(`${canonicalJsonStringify(schema)}\n`);
  });

  it("declares the 2020-12 dialect and a version-specific identifier", () => {
    const { $schema: dialect, $id: identifier } = manifestJsonSchema;
    expect(dialect).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(identifier).toBe("urn:holqa:schema:manifest:1");
  });
});