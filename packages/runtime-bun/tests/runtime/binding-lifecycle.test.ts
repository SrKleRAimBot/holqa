import type {
  BindingLifecycle,
  RuntimeBinding,
  TelemetryExporter
} from "@holqa/core";

import {
  bindingFailure,
  diagnosticsOf,
  HolqaError
} from "@holqa/core";
import {
  apiResource,
  application,
  configEntry,
  nonEmptyString,
  routeHandler,
  sequentialIds
} from "@test/support/descriptors";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  createRuntime,
  silentSink
} from "@/index";

/**
 * Creates an HTTP-only binding with a recording lifecycle.
 *
 * @param events - Where lifecycle calls are recorded.
 * @param overrides - Lifecycle hooks to replace.
 * @param telemetry - Exporters the binding's telemetry service selected.
 * @returns A binding that serves HTTP APIs and records its lifecycle.
 */
function lifecycleBinding(events: string[], overrides: Partial<BindingLifecycle> = {}, telemetry?: readonly TelemetryExporter[]): RuntimeBinding {
  let started = false;
  return {
    name: "composed",
    capabilities: { "http.api": {} },
    drivers: {},
    config: () => {
      events.push(`config:${started ? "started" : "not started"}`);
      return "value";
    },
    ...telemetry === undefined ? {} : { telemetry },
    lifecycle: {
      start: async ({ log }) => {
        events.push("start");
        log("info", "binding opened", { provider: "test" });
        started = true;
      },
      ready: async () => {
        events.push("ready");
      },
      health: async () => ({ status: "degraded", components: [{ name: "broker", status: "degraded", message: "Reconnecting." }] }),
      stop: async () => {
        events.push("stop");
      },
      ...overrides
    }
  };
}

const app = application([apiResource("api")], [configEntry("API_TOKEN", nonEmptyString, { sensitive: true })]);
const handlers = [routeHandler("ping", "api", "GET", "/ping")];

describe("binding lifecycle", () => {
  it("starts the binding before installing it, readies it after deliveries are registered, and stops it last", async () => {
    const events: string[] = [];
    const logs: string[] = [];
    const runtime = createRuntime({ app, handlers, binding: lifecycleBinding(events), log: entry => logs.push(entry.message), createId: sequentialIds() });
    await runtime.start();
    expect(events).toEqual(["start", "config:started", "ready"]);
    expect(logs).toContain("binding opened");
    expect((await runtime.fetch(new Request("http://localhost/api/ping"))).status).toBe(200);
    await runtime.stop();
    expect(events).toEqual(["start", "config:started", "ready", "stop"]);
  });

  it("stops a binding whose start failed part-way and reports the classified failure", async () => {
    const events: string[] = [];
    const binding = lifecycleBinding(events, {
      start: async () => {
        events.push("start");
        throw new HolqaError(bindingFailure("unavailable", { binding: "broker", message: "The broker refused the connection." }));
      }
    });
    const runtime = createRuntime({ app, handlers, binding, log: silentSink });
    let codes: string[] = [];
    try {
      await runtime.start();
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_BINDING_UNAVAILABLE"]);
    expect(events).toEqual(["start", "stop"]);
    expect(runtime.state).toBe("stopped");
  });

  it("stops the binding when it never becomes ready", async () => {
    const events: string[] = [];
    const runtime = createRuntime({
      app,
      handlers,
      binding: lifecycleBinding(events, {
        ready: async () => {
          throw new HolqaError(bindingFailure("failed", { binding: "s3", message: "The bucket does not exist." }));
        }
      }),
      log: silentSink
    });
    await expect(runtime.start()).rejects.toThrow();
    expect(events).toEqual(["start", "config:started", "stop"]);
  });

  it("aborts a start that exceeds limits.bindingStartMs", async () => {
    const runtime = createRuntime({
      app,
      handlers,
      limits: { bindingStartMs: 10 },
      binding: lifecycleBinding([], {
        start: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new HolqaError(bindingFailure("unavailable", { binding: "slow", message: "Timed out." }))), { once: true }))
      }),
      log: silentSink
    });
    let codes: string[] = [];
    try {
      await runtime.start();
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_BINDING_UNAVAILABLE"]);
  });

  it("logs a binding that fails to stop and still stops", async () => {
    const logs: string[] = [];
    const runtime = createRuntime({
      app,
      handlers,
      binding: lifecycleBinding([], {
        stop: async () => {
          throw new Error("socket already closed");
        }
      }),
      log: entry => logs.push(entry.message)
    });
    await runtime.start();
    await runtime.stop();
    expect(runtime.state).toBe("stopped");
    expect(logs).toContain("the binding failed to stop cleanly");
  });

  it("reports health: the runtime, then the binding's components, and readiness", async () => {
    const runtime = createRuntime({ app, handlers, binding: lifecycleBinding([]), log: silentSink });
    expect(await runtime.health()).toEqual({ status: "unhealthy", state: "idle", ready: false, components: [{ name: "runtime", status: "unhealthy", message: "The runtime is idle." }] });
    await runtime.start();
    expect(await runtime.health()).toEqual({
      status: "degraded",
      state: "running",
      ready: true,
      components: [{ name: "runtime", status: "healthy" }, { name: "broker", status: "degraded", message: "Reconnecting." }]
    });
    await runtime.stop();
    expect((await runtime.health()).ready).toBe(false);
  });

  it("exports to the binding's telemetry exporters and flushes them before the binding stops", async () => {
    const events: string[] = [];
    const exporter: TelemetryExporter = {
      name: "binding-exporter",
      exportSpans: async (spans) => {
        events.push(`spans:${spans.length}`);
      }
    };
    const runtime = createRuntime({ app, handlers, binding: lifecycleBinding(events, {}, [exporter]), log: silentSink });
    expect(runtime.telemetry.enabled).toBe(true);
    await runtime.start();
    await runtime.fetch(new Request("http://localhost/api/ping"));
    await runtime.stop();
    expect(events.indexOf("stop")).toBeGreaterThan(events.findIndex(event => event.startsWith("spans:")));
  });
});