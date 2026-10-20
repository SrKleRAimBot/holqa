import type {
  BindingStartOptions,
  ProviderContext,
  ResourceDescriptor,
  ResourceDescriptorOf
} from "@holqa/core";

import type { ProviderEvent } from "@test/support/fixtures";

import {
  bindApp,
  bindingFailure,
  credentialRef,
  diagnosticsOf,
  HolqaError
} from "@holqa/core";
import {
  createApp,
  sentMessages,
  testPlatform,
  testQueueProvider,
  testService
} from "@test/support/fixtures";

import {
  beforeEach,
  describe,
  expect,
  it
} from "bun:test";

import { createBinding } from "@/create-binding";
import { defineBindings } from "@/define-bindings";
import { resolveBindings } from "@/resolve";

/**
 * Creates start options that record logs.
 *
 * @param logs - Where log lines are recorded.
 * @returns Start options with a signal that never aborts.
 */
function startOptions(logs: string[] = []): BindingStartOptions {
  return { signal: new AbortController().signal, log: (level, message, fields) => logs.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`) };
}

/**
 * Returns the codes a promise rejects with.
 *
 * @param promise - A promise expected to reject with a Holqa error.
 * @returns The diagnostic codes.
 */
async function rejectedCodes(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return diagnosticsOf(error).map(diagnostic => diagnostic.code);
  }
  return [];
}

/**
 * Finds a resource descriptor of the test application.
 *
 * @param app - The application.
 * @param id - The resource identifier.
 * @returns The descriptor.
 */
function resourceOf<Kind extends ResourceDescriptor["kind"]>(app: ReturnType<typeof createApp>, id: string): ResourceDescriptorOf<Kind> {
  return app["~holqa"].resources.find(resource => resource.id === id) as ResourceDescriptorOf<Kind>;
}

beforeEach(() => {
  sentMessages.clear();
});

describe("createBinding", () => {
  it("routes each resource to the provider selected for it", async () => {
    const app = createApp();
    const binding = createBinding(resolveBindings(defineBindings(app, { defaults: testPlatform({}, { API_TOKEN: "secret-token" }), resources: { audit: testQueueProvider() } })));
    await binding.lifecycle!.start!(startOptions());
    const envelope = { format: "holqa.message/1", schemaVersion: 1, payload: "hello" } as const;
    await binding.drivers.queue!(resourceOf<"queue">(app, "orders")).send(envelope, {});
    await binding.drivers.queue!(resourceOf<"queue">(app, "audit")).send(envelope, {});
    expect(sentMessages.get("platform")).toEqual([{ queue: "orders", payload: "hello" }]);
    expect(sentMessages.get("broker")).toEqual([{ queue: "audit", payload: "hello" }]);
    expect(binding.describe!(resourceOf<"queue">(app, "audit"))).toEqual({ binding: "broker", capabilities: testQueueProvider().resources });
  });

  it("checks requirements against the selected provider when installed", () => {
    const app = createApp();
    // The broker cannot dead-letter, which "orders" requires.
    const binding = createBinding(resolveBindings(defineBindings(app, { defaults: testPlatform(), kinds: { queue: testQueueProvider() } })));
    let details: unknown[] = [];
    try {
      bindApp(app["~holqa"], binding);
    } catch (error) {
      details = diagnosticsOf(error).map(diagnostic => diagnostic.details);
    }
    expect(details).toEqual([{ resource: "orders", kind: "queue", binding: "broker", requirement: "queue.dead-letter" }]);
  });

  it("opens providers in resolution order and stops them in reverse", async () => {
    const events: ProviderEvent[] = [];
    const config = testService("config", { name: "secrets", events }, { config: { lookup: name => name === "API_TOKEN" ? "token" : undefined } });
    const binding = createBinding(resolveBindings(defineBindings(createApp(), { defaults: testPlatform({ events }), kinds: { queue: testQueueProvider({ events }) }, services: { config } })));
    await binding.lifecycle!.start!(startOptions());
    await binding.lifecycle!.ready!(new AbortController().signal);
    expect((await binding.lifecycle!.health!()).status).toBe("healthy");
    await binding.lifecycle!.stop!({ signal: new AbortController().signal });
    expect(events).toEqual(["open:secrets", "open:platform", "open:broker", "ready:secrets", "ready:platform", "ready:broker", "stop:broker", "stop:platform", "stop:secrets"]);
    expect((await binding.lifecycle!.health!()).status).toBe("unhealthy");
  });

  it("resolves credentials through the configuration service and never falls back when a provider fails", async () => {
    const events: ProviderEvent[] = [];
    const contexts: ProviderContext[] = [];
    const config = testService("config", { name: "secrets", events }, { config: { lookup: name => ({ API_TOKEN: "token", QUEUE_URL: "amqp://user:pa55word@broker" } as Record<string, string>)[name] } });
    const failing = {
      ...testQueueProvider({
        events,
        onOpen: context => contexts.push(context),
        fail: new Error("connect ECONNREFUSED amqp://user:pa55word@broker")
      }),
      credentials: [credentialRef("QUEUE_URL")]
    };
    const resolved = resolveBindings(defineBindings(createApp(), { defaults: testPlatform({ events }), kinds: { queue: failing }, services: { config } }));
    const binding = createBinding(resolved);
    let failure: unknown;
    try {
      await binding.lifecycle!.start!(startOptions());
    } catch (error) {
      failure = error;
    }
    expect(contexts[0]!.credential(credentialRef("QUEUE_URL"))).toBe("amqp://user:pa55word@broker");
    expect(contexts[0]!.resources.map(resource => String(resource.id))).toEqual(["audit", "orders"]);
    expect(diagnosticsOf(failure).map(diagnostic => [diagnostic.code, diagnostic.message])).toEqual([
      ["HOLQA_BINDING_FAILED", "Provider \"broker\" failed to start: connect ECONNREFUSED [redacted]"]
    ]);
    expect(events).toEqual(["open:secrets", "open:platform", "open:broker", "stop:platform", "stop:secrets"]);
    expect(await rejectedCodes(Promise.resolve().then(() => binding.drivers.queue!(resolved.resources[1]!.resource as ResourceDescriptorOf<"queue">)))).toEqual(["HOLQA_RUNTIME_NOT_RUNNING"]);
  });

  it("passes classified failures through unchanged", async () => {
    const unavailable = testQueueProvider({ fail: new HolqaError(bindingFailure("unavailable", { binding: "broker", message: "The broker refused the connection." })) });
    const binding = createBinding(resolveBindings(defineBindings(createApp(), { defaults: testPlatform({}, { API_TOKEN: "t" }), kinds: { queue: unavailable } })));
    expect(await rejectedCodes(binding.lifecycle!.start!(startOptions()))).toEqual(["HOLQA_BINDING_UNAVAILABLE"]);
  });

  it("reports a missing credential by name, without a value", async () => {
    const needsUrl = testQueueProvider({ onOpen: context => context.credential(credentialRef("QUEUE_URL")) });
    const binding = createBinding(resolveBindings(defineBindings(createApp(), { defaults: testPlatform({}, { API_TOKEN: "t" }), kinds: { queue: needsUrl } })));
    let details: unknown[] = [];
    try {
      await binding.lifecycle!.start!(startOptions());
    } catch (error) {
      details = diagnosticsOf(error).map(diagnostic => [diagnostic.code, diagnostic.details]);
    }
    expect(details).toEqual([["HOLQA_BINDING_CREDENTIALS_MISSING", { credential: "QUEUE_URL", binding: "broker", failure: "credentials-missing", transient: false }]]);
  });

  it("validates configuration entries after opening every provider, with defaults", async () => {
    const binding = createBinding(resolveBindings(defineBindings(createApp(), { defaults: testPlatform() })));
    expect(await rejectedCodes(binding.lifecycle!.start!(startOptions()))).toEqual(["HOLQA_CONFIG_INVALID"]);
    const configured = createBinding(resolveBindings(defineBindings(createApp(), { defaults: testPlatform({}, { API_TOKEN: "token" }) })));
    const app = createApp()["~holqa"];
    await configured.lifecycle!.start!(startOptions());
    expect(configured.config(app.config[0]!)).toBe("token");
    expect(configured.config(app.config[1]!)).toBe("eu");
  });

  it("uses configuration sources in order: the first that has a value wins", async () => {
    const first = testService("config", { name: "first" }, { config: { lookup: name => name === "REGION" ? "us" : undefined } });
    const second = testService("config", { name: "second" }, { config: { lookup: name => ({ REGION: "ap", API_TOKEN: "t" } as Record<string, string>)[name] } });
    const binding = createBinding(resolveBindings(defineBindings(createApp(), { defaults: testPlatform(), services: { config: [first, second] } })));
    await binding.lifecycle!.start!(startOptions());
    expect(binding.config(createApp()["~holqa"].config[1]!)).toBe("us");
  });

  it("refuses a provider that opens without a part it declares", async () => {
    const hollow = testService("telemetry", { name: "hollow" }, {});
    const binding = createBinding(resolveBindings(defineBindings(createApp(), { defaults: testPlatform({}, { API_TOKEN: "t" }), services: { telemetry: hollow } })));
    expect(await rejectedCodes(binding.lifecycle!.start!(startOptions()))).toEqual(["HOLQA_BINDING_CONFIG_INVALID"]);
  });

  it("forwards telemetry to the selected exporters once started, and event safety stores to their provider", async () => {
    const exported: string[] = [];
    const otlp = testService("telemetry", { name: "otlp" }, { telemetry: [{ name: "collector", exportSpans: async spans => void exported.push(`${spans.length}`) }] });
    const binding = createBinding(resolveBindings(defineBindings(createApp(), { defaults: testPlatform({}, { API_TOKEN: "t" }), services: { telemetry: otlp } })));
    expect(binding.telemetry?.map(exporter => exporter.name)).toEqual(["otlp"]);
    await binding.telemetry![0]!.exportSpans!([], { attributes: {} });
    expect(exported).toEqual([]);
    await binding.lifecycle!.start!(startOptions());
    await binding.telemetry![0]!.exportSpans!([], { attributes: {} });
    expect(exported).toEqual(["0"]);
    expect(await binding.idempotency!.complete("s", "k", "t", { retentionMs: 1 })).toBe(true);
    expect(binding.operationBudgets).toBeUndefined();
  });

  it("cannot be started twice", async () => {
    const binding = createBinding(resolveBindings(defineBindings(createApp(), { defaults: testPlatform({}, { API_TOKEN: "t" }) })));
    await binding.lifecycle!.start!(startOptions());
    expect(await rejectedCodes(binding.lifecycle!.start!(startOptions()))).toEqual(["HOLQA_RUNTIME_START_FAILED"]);
  });

  it("refuses resolutions with errors", () => {
    expect(() => createBinding(resolveBindings(defineBindings(createApp(), { kinds: { queue: testQueueProvider() } } as never)))).toThrow();
  });
});