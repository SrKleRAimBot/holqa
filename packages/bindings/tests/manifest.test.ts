import type { HolqaError } from "@holqa/core";

import {
  bindingContracts,
  credentialRef,
  diagnosticsOf
} from "@holqa/core";
import {
  createApp,
  testPlatform,
  testQueueProvider
} from "@test/support/fixtures";

import {
  describe,
  expect,
  it
} from "bun:test";

import { defineBindings } from "@/define-bindings";
import { inspectBindings } from "@/inspect";
import {
  bindingManifestFormat,
  createBindingManifest
} from "@/manifest";
import { resolveBindings } from "@/resolve";

/** The fingerprint the manifests are built against. */
const applicationManifest = `sha256:${"a".repeat(64)}`;

describe("createBindingManifest", () => {
  it("records providers, mappings, credential names and connectors without values", () => {
    const base = testQueueProvider();
    const broker = { ...base, resources: { queue: { ...base.resources.queue!, deadLetter: true } }, credentials: [credentialRef("BROKER_URL")], topology: { delivery: "pull" as const, state: "shared" as const, connectors: ["a message broker"] } };
    const report = inspectBindings(resolveBindings(defineBindings(createApp(), { name: "staging", defaults: testPlatform(), kinds: { queue: broker } })));
    const manifest = createBindingManifest(report, { applicationManifest });
    expect(manifest.format).toBe(bindingManifestFormat);
    expect(manifest.name).toBe("staging");
    expect(manifest.applicationManifest).toBe(applicationManifest);
    expect(manifest.compatibility).toEqual({ bindingProtocol: 1, contracts: { ...bindingContracts } });
    expect(manifest.resources.filter(resource => resource.kind === "queue").map(resource => [resource.provider, resource.selection])).toEqual([["broker", "kind"], ["broker", "kind"]]);
    expect(manifest.credentials).toEqual(["BROKER_URL"]);
    expect(manifest.connectors).toEqual([{ provider: "broker", connector: "a message broker" }]);
    expect(manifest.providers.map(provider => provider.settings)).toContainEqual({ cluster: "primary" });
    expect("diagnostics" in manifest).toBe(false);
  });

  it("is the same data for the same configuration", () => {
    /**
     * Builds the manifest of a fresh, identical configuration.
     *
     * @returns The manifest.
     */
    const build = () => createBindingManifest(inspectBindings(resolveBindings(defineBindings(createApp(), { defaults: testPlatform() }))), { applicationManifest });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it("refuses an invalid configuration", () => {
    let error: HolqaError | undefined;
    try {
      createBindingManifest(inspectBindings(resolveBindings(defineBindings(createApp(), { kinds: { queue: testQueueProvider() } } as never))), { applicationManifest });
    } catch (caught) {
      error = caught as HolqaError;
    }
    expect(diagnosticsOf(error).map(diagnostic => diagnostic.code)).toContain("HOLQA_BINDING_MISSING");
  });
});