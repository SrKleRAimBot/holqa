import type { Diagnostic } from "@holqa/core";

import type { ValidatedHandler } from "@/validate";

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
import {
  bindingReportFormat,
  inspectBindings
} from "@/inspect";
import { resolveBindings } from "@/resolve";
import { validateBindings } from "@/validate";

/**
 * Builds a handler for a trigger kind.
 *
 * @param id - The handler identifier.
 * @param kind - The trigger kind.
 * @param resource - The resource identifier.
 * @param extra - Further fields, such as `idempotency`.
 * @returns The handler, as a manifest lists it.
 */
function handler(id: string, kind: ValidatedHandler["trigger"]["kind"], resource: string, extra: Partial<ValidatedHandler> = {}): ValidatedHandler {
  const resourceKind = kind === "queue.message" ? "queue" : kind === "schedule.tick" ? "schedule" : kind.startsWith("bucket.") ? "bucket" : "http.api";
  return { id, trigger: { kind, resource: { kind: resourceKind, id: resource }, options: {} }, ...extra } as ValidatedHandler;
}

/**
 * Reads one detail of a diagnostic.
 *
 * @param diagnostic - The diagnostic whose details are read.
 * @param key - The detail's name.
 * @returns The detail's value, if present.
 */
function field(diagnostic: Diagnostic, key: string): unknown {
  return (diagnostic.details as Readonly<Record<string, unknown>> | undefined)?.[key];
}

const handlers = [
  handler("orders.process", "queue.message", "orders"),
  handler("audit.record", "queue.message", "audit"),
  handler("files.scan", "bucket.object-created", "files"),
  handler("nightly.run", "schedule.tick", "nightly")
];

describe("validateBindings", () => {
  it("accepts a configuration whose providers meet every requirement", () => {
    expect(validateBindings(resolveBindings(defineBindings(createApp(), { defaults: testPlatform() })), { handlers })).toEqual([]);
  });

  it("reports unmet requirements against the provider selected for each resource", () => {
    const diagnostics = validateBindings(resolveBindings(defineBindings(createApp(), { defaults: testPlatform(), kinds: { queue: testQueueProvider() } })), { handlers });
    expect(diagnostics.map(diagnostic => [diagnostic.code, field(diagnostic, "resource") ?? field(diagnostic, "handler"), field(diagnostic, "requirement")])).toEqual([
      ["HOLQA_BINDING_CAPABILITY_UNSUPPORTED", "orders", "queue.dead-letter"],
      ["HOLQA_BINDING_CAPABILITY_UNSUPPORTED", "orders.process", "trigger.queue.message"],
      ["HOLQA_BINDING_CAPABILITY_UNSUPPORTED", "audit.record", "trigger.queue.message"]
    ]);
  });

  it("returns the resolution's errors without further checks", () => {
    const diagnostics = validateBindings(resolveBindings(defineBindings(createApp(), { kinds: { queue: testQueueProvider() } } as never)), { handlers });
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_BINDING_MISSING", "HOLQA_BINDING_MISSING", "HOLQA_BINDING_MISSING"]);
  });

  it("rejects a topology that cannot deliver background handlers", () => {
    const sendOnly = { ...testQueueProvider({ name: "send-only" }), resources: { queue: { delivery: ["at-least-once"], maxAttempts: 100, deadLetter: true, backoff: ["fixed", "exponential"], maxDelaySeconds: 900 } }, topology: { delivery: "none", state: "shared" } } as ReturnType<typeof testQueueProvider>;
    const diagnostics = validateBindings(resolveBindings(defineBindings(createApp(), { defaults: testPlatform(), resources: { audit: sendOnly } })), { handlers });
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.details])).toEqual([
      ["HOLQA_BINDING_TOPOLOGY_UNSUPPORTED", { handler: "audit.record", resource: "audit", binding: "send-only" }]
    ]);
    const requestDriven = testPlatform({ name: "functions" });
    const serverless = { ...requestDriven, execution: { runtimes: ["bun"], mode: "request-driven" } } as typeof requestDriven;
    const host = validateBindings(resolveBindings(defineBindings(createApp(), { defaults: serverless })), { handlers: [handler("orders.process", "queue.message", "orders")] });
    expect(host.map(diagnostic => [diagnostic.code, field(diagnostic, "host")])).toEqual([["HOLQA_BINDING_TOPOLOGY_UNSUPPORTED", "functions"]]);
  });

  it("checks runtime limits against the execution host", () => {
    const limited = { ...testPlatform(), execution: { runtimes: ["bun"], mode: "long-running", maxTimeoutMs: 10_000, maxConcurrency: 8 } } as ReturnType<typeof testPlatform>;
    const resolved = resolveBindings(defineBindings(createApp(), { defaults: limited }));
    expect(validateBindings(resolved, { limits: { timeoutMs: 5_000, concurrency: 8 } })).toEqual([]);
    expect(validateBindings(resolved, { limits: { concurrency: 16 } }).map(diagnostic => field(diagnostic, "requirement"))).toEqual(["execution.timeout", "execution.concurrency"]);
  });

  it("requires the event safety stores handlers and the runtime need", () => {
    const platform = testPlatform();
    const resolved = resolveBindings(defineBindings(createApp(), { kinds: { queue: platform }, resources: { files: platform, nightly: platform, api: platform } }));
    expect(validateBindings(resolved, { handlers: [handler("orders.process", "queue.message", "orders", { idempotency: {} })], operationBudgets: true }).map(diagnostic => field(diagnostic, "requirement"))).toEqual(["idempotency", "operation-budgets"]);
    const { idempotency: _idempotency, ...contracts } = testPlatform().contracts;
    const withoutStores = resolveBindings(defineBindings(createApp(), { defaults: { ...testPlatform(), services: { config: true, telemetry: true }, contracts } as never }));
    expect(validateBindings(withoutStores, { handlers: [handler("orders.process", "queue.message", "orders", { idempotency: {} })] }).map(diagnostic => field(diagnostic, "requirement"))).toEqual(["idempotency"]);
  });
});

describe("inspectBindings", () => {
  it("describes each resource's provider, why it was selected and how each requirement is met", () => {
    const emulating = { ...testQueueProvider(), resources: { queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, backoff: ["fixed", "exponential"], maxDelaySeconds: 900 } }, emulations: [{ kind: "queue", capability: "queue.backoff.exponential", mechanism: "delay queues" }] } as ReturnType<typeof testQueueProvider>;
    const app = createApp();
    const report = inspectBindings(resolveBindings(defineBindings(app, { name: "staging", defaults: testPlatform(), resources: { audit: emulating, orders: testQueueProvider({ name: "plain" }) } })), { handlers });
    expect(report.format).toBe(bindingReportFormat);
    expect(report.application).toBe("shop");
    expect(report.resources.map(resource => [resource.id, resource.provider, resource.selection])).toEqual([
      ["api", "platform", "default"],
      ["audit", "broker", "resource"],
      ["files", "platform", "default"],
      ["nightly", "platform", "default"],
      ["orders", "plain", "resource"]
    ]);
    expect(report.resources.find(resource => resource.id === "orders")!.requirements).toEqual([
      { capability: "queue", support: "native" },
      { capability: "queue.delivery.at-least-once", support: "native" },
      { capability: "queue.dead-letter", support: "unsupported" },
      { capability: "trigger.queue.message", support: "unsupported" }
    ]);
    expect(report.providers.find(provider => provider.name === "broker")).toEqual({
      name: "broker",
      provider: "example.broker",
      role: "resource",
      contracts: { queue: 1 },
      capabilities: { queue: ["queue", "queue.backoff.exponential", "queue.backoff.fixed", "queue.dead-letter", "queue.delay", "queue.delivery.at-least-once", "queue.max-attempts"] },
      limits: { queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, backoff: ["fixed", "exponential"], maxDelaySeconds: 900 } },
      services: [],
      emulations: [{ kind: "queue", capability: "queue.backoff.exponential", mechanism: "delay queues" }],
      extensions: [],
      topology: { delivery: "pull", state: "shared" },
      settings: { cluster: "primary" },
      credentials: []
    });
    expect(report.services.map(service => [service.service, service.providers, service.selection])).toEqual([
      ["config", ["platform"], "default"],
      ["telemetry", ["platform"], "default"],
      ["idempotency", ["platform"], "default"]
    ]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("marks an emulated requirement as emulated", () => {
    const backoffQueue = { protocol: 1, type: "resource", kind: "queue", id: "jobs", config: { schemaVersion: 1 }, requirements: { delivery: "at-least-once", deadLetter: false, backoff: { strategy: "exponential", initialDelaySeconds: 1, maxDelaySeconds: 60 } }, schemas: {} };
    const app = createApp();
    const descriptor = { ...app["~holqa"], resources: [...app["~holqa"].resources, backoffQueue] };
    const emulating = { ...testQueueProvider(), resources: { queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, backoff: ["exponential"], maxDelaySeconds: 900 } }, emulations: [{ kind: "queue", capability: "queue.backoff.exponential", mechanism: "delay queues" }] } as ReturnType<typeof testQueueProvider>;
    const report = inspectBindings(resolveBindings(defineBindings({ ...app, "~holqa": descriptor } as never, { defaults: testPlatform(), resources: { jobs: emulating } } as never)));
    expect(report.resources.find(resource => resource.id === "jobs")!.requirements.at(-1)).toEqual({ capability: "queue.backoff.exponential", support: "emulated" });
  });
});