import type { Diagnostic } from "@holqa/core";

import {
  compiledShop,
  copy
} from "@test/support/manifests";

import {
  describe,
  expect,
  it
} from "bun:test";
import {
  validateEntrypoints,
  validateManifest
} from "@/index";

/**
 * Reads the JSON path a `HOLQA_MANIFEST_INVALID` diagnostic reports.
 *
 * @param diagnostic - A diagnostic from a validator.
 * @param diagnostic.details - Its structured details.
 * @returns The `details.path` value.
 */
function pathOf({ details }: Diagnostic): unknown {
  const { path } = details ?? {};
  return path;
}

/**
 * Validates a tampered manifest and returns its problems.
 *
 * @param tamper - Changes the copy of a valid manifest.
 * @returns The codes and JSON paths reported.
 */
async function problems(tamper: (manifest: any) => void): Promise<Array<[string, unknown]>> {
  const manifest = copy((await compiledShop()).manifest);
  tamper(manifest);
  const result = validateManifest(manifest);
  return result.ok ? [] : result.error.map(diagnostic => [diagnostic.code, pathOf(diagnostic)]);
}

describe("validateManifest", () => {
  it("accepts a compiled manifest", async () => {
    const { manifest } = await compiledShop();
    expect(validateManifest(copy(manifest))).toEqual({ ok: true, value: copy(manifest) });
  });

  it("rejects values that are not plain JSON data", async () => {
    const manifest = copy((await compiledShop()).manifest);
    manifest.application.description = new Date(0);
    const result = validateManifest(manifest);
    expect(result.ok ? [] : result.error.map(pathOf)).toEqual(["$"]);
  });

  it("rejects other manifest versions before anything else", () => {
    const result = validateManifest({ manifestVersion: 2 });
    expect(result.ok ? [] : result.error.map(diagnostic => [diagnostic.code, diagnostic.details])).toEqual([["HOLQA_MANIFEST_VERSION_UNSUPPORTED", { found: 2, supported: [1] }]]);
  });

  it.each([
    ["a missing section", (manifest: any) => delete manifest.schemas, "$"],
    ["an unknown property", (manifest: any) => manifest.resources[0].config.providerOptions = {}, "$.resources[0].config.providerOptions"],
    ["an invalid identifier", (manifest: any) => manifest.handlers[0].id = "Orders", "$.handlers[0].id"],
    ["a trigger option of the wrong type", (manifest: any) => manifest.handlers[2].trigger.options.concurrency = "4", "$.handlers[2].trigger.options.concurrency"],
    ["an absolute fingerprint key", (manifest: any) => manifest.schemas["/tmp/x"] = {}, "$.schemas[\"/tmp/x\"]"]
  ])("rejects %s", async (_name, tamper, path) => {
    expect(await problems(tamper)).toContainEqual(["HOLQA_MANIFEST_INVALID", path]);
  });

  it.each([
    ["an unknown strategy", { strategy: "linear", delaySeconds: 1 }],
    ["a negative delay", { strategy: "fixed", delaySeconds: -1 }],
    ["an extra property", { strategy: "fixed", delaySeconds: 1, jitter: true }],
    ["a missing maximum", { strategy: "exponential", initialDelaySeconds: 1 }],
    ["a multiplier below 1", { strategy: "exponential", initialDelaySeconds: 1, maxDelaySeconds: 5, multiplier: 0.5 }]
  ])("rejects a queue backoff with %s", async (_name, backoff) => {
    const found = await problems((manifest) => {
      const queue = manifest.resources.find((resource: { kind: string }) => resource.kind === "queue");
      queue.requirements.backoff = backoff;
    });
    expect(found.map(([code]) => code)).toContain("HOLQA_MANIFEST_INVALID");
  });

  it("accepts a valid queue backoff and an object-deleted trigger, and rejects a malformed one", async () => {
    /**
     * Adds a backoff and turns the object-created trigger into an object-deleted one.
     *
     * @param manifest - The manifest copy to change.
     * @returns The object handler's trigger.
     */
    const toDeleted = (manifest: any): { options: { prefix?: unknown } } => {
      manifest.resources.find((resource: { kind: string }) => resource.kind === "queue").requirements.backoff = { strategy: "fixed", delaySeconds: 5 };
      const handler = manifest.handlers.find((candidate: { trigger: { kind: string } }) => candidate.trigger.kind === "bucket.object-created");
      handler.trigger.kind = "bucket.object-deleted";
      return handler.trigger;
    };
    expect(await problems((manifest) => {
      toDeleted(manifest);
    })).toEqual([]);
    expect((await problems((manifest) => {
      toDeleted(manifest).options.prefix = 3;
    })).map(([code]) => code)).toContain("HOLQA_MANIFEST_INVALID");
  });

  it("rejects cross-reference problems a JSON Schema cannot express", async () => {
    expect(await problems(manifest => manifest.resources.reverse())).toContainEqual(["HOLQA_MANIFEST_INVALID", "$.resources[1]"]);
    expect(await problems(manifest => manifest.handlers[2].trigger.resource.id = "missing")).toEqual([["HOLQA_MANIFEST_INVALID", "$.handlers[2].trigger.resource"]]);
    expect(await problems(manifest => manifest.config[0].default = "x")).toEqual([["HOLQA_MANIFEST_INVALID", "$.config[0].default"]]);
    expect(await problems(manifest => delete manifest.resources[1].schemas.message)).toEqual([["HOLQA_MANIFEST_INVALID", "$.resources[1].schemas"]]);
    expect(await problems(manifest => manifest.resources[2].schemas.message = manifest.resources[1].schemas.message)).toEqual([["HOLQA_MANIFEST_INVALID", "$.resources[2].schemas"]]);
    expect(await problems(manifest => manifest.resources[1].schemas.message.schemaVersion = 2)).toEqual([["HOLQA_MANIFEST_INVALID", "$.resources[1].schemas.message.schemaVersion"]]);
    expect(await problems(manifest => manifest.handlers[2].schemas = {})).toEqual([["HOLQA_MANIFEST_INVALID", "$.handlers[2].schemas"]]);
    expect(await problems((manifest) => {
      const [first] = Object.keys(manifest.schemas);
      delete manifest.schemas[first!];
    })).not.toEqual([]);
  });
});

describe("validateEntrypoints", () => {
  it("accepts the entry points compiled with the manifest", async () => {
    const { manifest, entrypoints } = await compiledShop();
    expect((await validateEntrypoints(copy(entrypoints), manifest)).ok).toBe(true);
  });

  it("rejects entry points of another manifest or with other handlers", async () => {
    const { manifest, entrypoints } = await compiledShop();
    const other = copy(entrypoints);
    other.manifest = `sha256:${"0".repeat(64)}`;
    other.handlers.pop();
    other.handlers[0].export = "missing";
    const result = await validateEntrypoints(other, manifest);
    expect(result.ok ? [] : result.error.map(pathOf)).toEqual(["$.manifest", "$.handlers", "$.handlers[0].export"]);
  });

  it("rejects absolute or escaping module paths", async () => {
    const { manifest, entrypoints } = await compiledShop();
    for (const path of ["/abs/a.ts", "../a.ts", "C:/a.ts", "src\\a.ts", "src/./a.ts"]) {
      const tampered = copy(entrypoints);
      tampered.handlers[0].module = path;
      const result = await validateEntrypoints(tampered, manifest);
      expect(result.ok ? [] : result.error.map(pathOf)).toEqual(["$.handlers[0].module"]);
    }
  });
});