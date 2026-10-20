import {
  createApp,
  names,
  testPlatform,
  testQueueProvider,
  testService
} from "@test/support/fixtures";
import {
  describe,
  expect,
  it
} from "bun:test";

import { defineBindings } from "@/define-bindings";
import {
  assertResolved,
  resolveBindings
} from "@/resolve";

describe("resolveBindings", () => {
  it("resolves by fixed precedence: resource entry, then kind entry, then defaults", () => {
    const platform = testPlatform();
    const broker = testQueueProvider({ name: "broker" });
    const audit = testQueueProvider({ name: "audit-broker" });
    const resolved = resolveBindings(defineBindings(createApp(), { defaults: platform, kinds: { queue: broker }, resources: { audit } }));
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.resources.map(selection => [selection.resource.id, selection.provider.name, selection.source])).toEqual([
      ["api", "platform", "default"],
      ["audit", "audit-broker", "resource"],
      ["files", "platform", "default"],
      ["nightly", "platform", "default"],
      ["orders", "broker", "kind"]
    ]);
  });

  it("is deterministic regardless of the order entries were written in", () => {
    const platform = testPlatform();
    const first = testQueueProvider({ name: "first" });
    const second = testQueueProvider({ name: "second" });
    const a = resolveBindings(defineBindings(createApp(), { defaults: platform, resources: { orders: first, audit: second } }));
    const b = resolveBindings(defineBindings(createApp(), { resources: { audit: second, orders: first }, defaults: platform }));
    expect(names(a.providers)).toEqual(names(b.providers));
    expect(a.resources.map(selection => selection.provider.name)).toEqual(b.resources.map(selection => selection.provider.name));
  });

  it("orders providers for opening: configuration, other services, then resource providers", () => {
    const telemetry = testService("telemetry", { name: "otlp" }, {});
    const config = testService("config", { name: "secrets" }, {});
    const resolved = resolveBindings(defineBindings(createApp(), { defaults: testPlatform(), kinds: { queue: testQueueProvider() }, services: { telemetry, config } }));
    expect(names(resolved.providers)).toEqual(["secrets", "otlp", "platform", "broker"]);
    expect(resolved.services.map(selection => [selection.service, names(selection.providers), selection.source])).toEqual([
      ["config", ["secrets"], "service"],
      ["telemetry", ["otlp"], "service"],
      ["idempotency", ["platform"], "default"]
    ]);
  });

  it("falls back to environment variables for configuration only when nothing else supplies it", () => {
    const resolved = resolveBindings(defineBindings(createApp(), { kinds: { queue: testQueueProvider() }, resources: { files: testPlatform(), nightly: testPlatform(), api: testPlatform() } }));
    expect(resolved.services.map(selection => [selection.service, names(selection.providers), selection.source])).toEqual([["config", ["environment"], "builtin"]]);
  });

  it("never falls through to the next level when a selected provider does not bind the kind", () => {
    const resolved = resolveBindings(defineBindings(createApp(), { defaults: testPlatform(), resources: { files: testQueueProvider() } } as never));
    expect(resolved.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.details])).toEqual([
      ["HOLQA_BINDING_KIND_MISMATCH", { resource: "files", kind: "bucket", binding: "broker", selection: "resource" }]
    ]);
    expect(resolved.resources.map(selection => selection.resource.id)).not.toContain("files");
    expect(() => assertResolved(resolved)).toThrow();
  });

  it("reports undeclared resources and kinds, and resources without a provider", () => {
    const resolved = resolveBindings(defineBindings(createApp(), { kinds: { queue: testQueueProvider() }, resources: { payments: testQueueProvider() } } as never));
    expect(resolved.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.details])).toEqual([
      ["HOLQA_BINDING_RESOURCE_UNKNOWN", { resource: "payments" }],
      ["HOLQA_BINDING_MISSING", { resource: "api", kind: "http.api" }],
      ["HOLQA_BINDING_MISSING", { resource: "files", kind: "bucket" }],
      ["HOLQA_BINDING_MISSING", { resource: "nightly", kind: "schedule" }]
    ]);
    const kinds = resolveBindings(defineBindings(createApp(), { defaults: testPlatform(), kinds: { "topic": testQueueProvider(), "static.site": testQueueProvider() } } as never));
    expect(kinds.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_BINDING_RESOURCE_UNKNOWN", "HOLQA_BINDING_CONFIG_INVALID"]);
  });

  it("reports a service provider that does not supply the service, and empty lists", () => {
    const resolved = resolveBindings(defineBindings(createApp(), { defaults: testPlatform(), services: { telemetry: testQueueProvider(), config: [] } } as never));
    expect(resolved.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_BINDING_CONFIG_INVALID", "HOLQA_BINDING_KIND_MISMATCH"]);
  });

  it("validates every selected provider and reports where it was selected", () => {
    const broken = { ...testQueueProvider(), contracts: { queue: 2 } };
    const resolved = resolveBindings(defineBindings(createApp(), { defaults: testPlatform(), resources: { orders: broken, audit: broken } } as never));
    expect(resolved.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.message])).toEqual([
      ["HOLQA_BINDING_CONTRACT_INCOMPATIBLE", "resources[\"audit\"]: Provider \"broker\": it implements version 2 of the queue contract, but this version of Holqa implements version 1."]
    ]);
  });

  it("rejects two different providers with the same name", () => {
    const resolved = resolveBindings(defineBindings(createApp(), { defaults: testPlatform(), resources: { orders: testQueueProvider({ name: "broker" }), audit: testQueueProvider({ name: "broker" }) } }));
    expect(resolved.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.details])).toEqual([["HOLQA_BINDING_CONFIG_INVALID", { binding: "broker" }]]);
  });
});