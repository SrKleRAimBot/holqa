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
  fingerprintManifest,
  serializeManifest
} from "@/index";

describe("serializeManifest", () => {
  it("writes canonical JSON that does not depend on key insertion order", async () => {
    const { manifest } = await compiledShop();
    const reordered = Object.fromEntries(Object.entries(copy(manifest)).reverse());
    expect(serializeManifest(reordered as unknown as typeof manifest)).toBe(serializeManifest(manifest));
    expect(serializeManifest(manifest).endsWith("}")).toBe(true);
  });
});

describe("fingerprintManifest", () => {
  it("hashes the canonical text and changes with the content", async () => {
    const { manifest } = await compiledShop();
    const fingerprint = await fingerprintManifest(manifest);
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await fingerprintManifest(copy(manifest))).toBe(fingerprint);
    expect(await fingerprintManifest({ ...manifest, runtime: "bun", application: { name: manifest.application.name, description: "x" } })).not.toBe(fingerprint);
  });
});