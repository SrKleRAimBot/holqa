import type { LogEntry } from "@holqa/runtime-bun";

import {
  createBinding,
  defineBindings,
  resolveBindings
} from "@holqa/bindings";
import { diagnosticsOf } from "@holqa/core";
import { localEnvironment } from "@holqa/local";
import {
  createRuntime,
  silentSink
} from "@holqa/runtime-bun";
import {
  defineApp,
  queue
} from "@holqa/sdk";
import { stringRecord } from "@test/support/schemas";
import {
  describe,
  expect,
  it
} from "bun:test";

import { withFaults } from "@/bindings/faulty-provider";

/**
 * Builds an application with one queue and a consumer that records messages.
 *
 * @returns The application, its consumer and what it received.
 */
function shop() {
  const jobs = queue({ id: "jobs", message: stringRecord("id"), schemaVersion: 1 });
  const app = defineApp({ name: "shop", resources: { jobs } });
  const received: string[] = [];
  const consumer = jobs.consume({ id: "jobs.process", handler: async ({ message }) => void received.push(message.id) });
  return { app, jobs, consumer, received };
}

/**
 * Collects the diagnostic codes of a rejected promise.
 *
 * @param promise - The promise expected to reject.
 * @returns The codes.
 */
async function rejection(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return diagnosticsOf(error).map(diagnostic => diagnostic.code);
  }
  return [];
}

describe("withFaults through a composed binding", () => {
  it("fails a start with the injected classification, closes what opened and never falls back", async () => {
    const { app, consumer } = shop();
    const env = localEnvironment({ persistence: "memory", env: {} });
    const broker = withFaults(env.queues(), { open: "unavailable" });
    const binding = createBinding(resolveBindings(defineBindings(app, { defaults: env.platform(), kinds: { queue: broker } })));
    const runtime = createRuntime({ app, handlers: [consumer], binding, log: silentSink });
    expect(await rejection(runtime.start())).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_BINDING_UNAVAILABLE"]);
    expect(broker.counters.opened).toBe(1);
    expect(env.state()).toBeUndefined();
  });

  it("reports invalid credentials as permanent", async () => {
    const { app, consumer } = shop();
    const env = localEnvironment({ persistence: "memory", env: {} });
    const binding = createBinding(resolveBindings(defineBindings(app, { defaults: withFaults(env.platform(), { open: "credentials-invalid" }) })));
    const runtime = createRuntime({ app, handlers: [consumer], binding, log: silentSink });
    expect(await rejection(runtime.start())).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_BINDING_CREDENTIALS_INVALID"]);
  });

  it("aborts a provider that hangs while opening when the start time limit passes", async () => {
    const { app, consumer } = shop();
    const env = localEnvironment({ persistence: "memory", env: {} });
    const binding = createBinding(resolveBindings(defineBindings(app, { defaults: env.platform(), kinds: { queue: withFaults(env.queues(), { openHangs: true }) } })));
    const runtime = createRuntime({ app, handlers: [consumer], binding, log: silentSink, limits: { bindingStartMs: 50 } });
    expect(await rejection(runtime.start())).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_BINDING_UNAVAILABLE"]);
  });

  it("surfaces a temporary send failure to the caller and recovers", async () => {
    const { app, jobs, consumer, received } = shop();
    const env = localEnvironment({ persistence: "memory", env: {} });
    const binding = createBinding(resolveBindings(defineBindings(app, { defaults: env.platform(), kinds: { queue: withFaults(env.queues(), { operationFailures: 1 }) } })));
    const runtime = createRuntime({ app, handlers: [consumer], binding, log: silentSink });
    await runtime.start();
    try {
      expect(await rejection(jobs.send({ id: "first" }))).toEqual(["HOLQA_BINDING_UNAVAILABLE"]);
      await jobs.send({ id: "second" });
      await env.state()!.settle();
      expect(received).toEqual(["second"]);
    } finally {
      await runtime.stop();
    }
  });

  it("keeps delivering after receiving fails, as after a lost connection", async () => {
    const { app, jobs, consumer, received } = shop();
    const env = localEnvironment({ persistence: "memory", env: {} });
    const logs: LogEntry[] = [];
    const binding = createBinding(resolveBindings(defineBindings(app, { defaults: env.platform(), kinds: { queue: withFaults(env.queues(), { receiveFailures: 1 }) } })));
    const runtime = createRuntime({ app, handlers: [consumer], binding, log: entry => logs.push(entry) });
    await runtime.start();
    try {
      await jobs.send({ id: "after-reconnect" });
      for (let waited = 0; received.length === 0 && waited < 5_000; waited += 50)
        await Bun.sleep(50);
      expect(received).toEqual(["after-reconnect"]);
      expect(logs.map(entry => entry.message)).toContain("receiving deliveries failed; retrying");
    } finally {
      await runtime.stop();
    }
  });

  it("stops the runtime even when a provider fails to stop, and reports health it is given", async () => {
    const { app, consumer } = shop();
    const env = localEnvironment({ persistence: "memory", env: {} });
    const broker = withFaults(env.queues(), { stopFails: true, health: "degraded" });
    const binding = createBinding(resolveBindings(defineBindings(app, { defaults: env.platform(), kinds: { queue: broker } })));
    const runtime = createRuntime({ app, handlers: [consumer], binding, log: silentSink });
    await runtime.start();
    expect((await runtime.health()).components.find(component => component.name === "local.queues")?.status).toBe("degraded");
    await runtime.stop();
    expect(runtime.state).toBe("stopped");
    expect(broker.counters.stopped).toBe(1);
    expect(env.state()).toBeUndefined();
  });

  it("can report lost leases on settlement", async () => {
    const { app } = shop();
    const env = localEnvironment({ persistence: "memory", env: {} });
    const faulty = withFaults(env.queues(), { lostLeases: 1 });
    const instance = await faulty.open({ app: app["~holqa"], environment: "test", resources: app["~holqa"].resources, credential: () => "", signal: new AbortController().signal, log: () => {} });
    const resource = app["~holqa"].resources[0]! as never;
    await instance.drivers!.queue!(resource).send({ format: "holqa.message/1", schemaVersion: 1, payload: { id: "x" } }, {});
    const source = instance.sources!.queue!(resource);
    const [delivery] = await source.receive({ max: 1, leaseMs: 60_000 });
    expect(await source.acknowledge(delivery!.receipt)).toBe(false);
    expect(await source.acknowledge(delivery!.receipt)).toBe(true);
    await instance.stop!({ signal: new AbortController().signal });
  });
});