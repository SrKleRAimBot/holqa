import type {
  DriverOperationContext,
  HandlerDescriptor,
  InvocationContext,
  MessageEnvelope,
  ResourceDescriptor,
  RuntimeBinding
} from "@holqa/core";

import type { LogEntry } from "@/logging/log";
import type { RuntimeOptions } from "@/runtime/create-runtime";

import { resolveDriver } from "@holqa/core";
import {
  apiResource,
  application,
  configEntry,
  described,
  id,
  nonEmptyString,
  queueResource,
  recordingSink,
  routeHandler,
  scheduleHandler,
  scheduleResource,
  sequentialIds
} from "@test/support/descriptors";
import { MemorySource } from "@test/support/memory-sources";
import {
  recordingExporter,
  sequentialTelemetryIds
} from "@test/support/telemetry";
import {
  describe,
  expect,
  it
} from "bun:test";

import { createRuntime } from "@/runtime/create-runtime";

/** The `jobs` queue, with non-empty string messages. */
const jobs = { ...queueResource("jobs"), schemas: { message: nonEmptyString } } as ResourceDescriptor & { readonly kind: "queue" };

/** The value of the declared secret `API_TOKEN`. */
const secret = "tok-5ecret-value";

/** An incoming W3C trace context. */
const callerTrace = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

/**
 * Creates a binding that records the context of every send and delivers the
 * `jobs` queue from an in-memory source.
 *
 * @param source - The queue's deliveries.
 * @returns The binding and the recorded send contexts.
 */
function bindingWith(source = new MemorySource<MessageEnvelope>()): { readonly binding: RuntimeBinding; readonly sends: Array<DriverOperationContext | undefined> } {
  const sends: Array<DriverOperationContext | undefined> = [];
  return {
    sends,
    binding: {
      name: "recording",
      capabilities: {
        "queue": { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, backoff: ["fixed", "exponential"], maxDelaySeconds: 900 },
        "schedule": { overlap: ["skip"] },
        "http.api": {}
      },
      drivers: {
        queue: () => ({
          send: async (_envelope, _options, context) => {
            sends.push(context);
            return { messageId: `m-${sends.length}` };
          }
        })
      },
      sources: { queue: () => Object.assign(source, { pending: async () => 3 }) },
      config: entry => entry.name === "API_TOKEN" ? secret : undefined
    }
  };
}

/**
 * Builds a consumer of the `jobs` queue.
 *
 * @param handle - Runs for every message.
 * @returns A value carrying the handler descriptor.
 */
function consumer(handle: (context: InvocationContext<{ readonly attempt: number; readonly messageId: string }>) => unknown = () => undefined): ReturnType<typeof described<HandlerDescriptor>> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id("jobs.run"), trigger: { kind: "queue.message", resource: { kind: "queue", id: id("jobs") }, options: {} } },
    schemas: { message: nonEmptyString },
    invoke: async (_input: unknown, context: InvocationContext<{ readonly attempt: number; readonly messageId: string }>) => handle(context)
  } as HandlerDescriptor);
}

/**
 * Creates a runtime with telemetry recorded in memory and sequential identifiers.
 *
 * @param options - The application, handlers, binding and overrides.
 * @returns The runtime, the exporter and the log entries.
 */
function telemetryRuntime(options: Partial<RuntimeOptions> & Pick<RuntimeOptions, "app" | "handlers">): { readonly runtime: ReturnType<typeof createRuntime>; readonly exporter: ReturnType<typeof recordingExporter>; readonly entries: LogEntry[] } {
  const exporter = recordingExporter();
  const { sink, entries } = recordingSink();
  const runtime = createRuntime({ log: sink, createId: sequentialIds(), ...options, telemetry: { exporters: [exporter], ids: sequentialTelemetryIds(), ...options.telemetry } });
  return { runtime, exporter, entries };
}

describe("runtime telemetry", () => {
  it("continues a caller's trace through an HTTP request and the message it publishes, and correlates logs", async () => {
    const app = application([apiResource("shop-api"), jobs], [configEntry("API_TOKEN", nonEmptyString, { sensitive: true })]);
    const { binding, sends } = bindingWith();
    const seen: unknown[] = [];
    const handler = routeHandler("orders.get", "shop-api", "GET", "/orders/:orderId", async (_input, context) => {
      seen.push(context.telemetry);
      context.log.info(`calling the payment service with ${secret}`, { authorization: "Bearer abc", orderId: "o-1" });
      await resolveDriver(app["~holqa"], jobs, "send").send({ format: "holqa.message/1", schemaVersion: 1, payload: "o-1" }, {});
      return new Response("ok");
    });
    const { runtime, exporter, entries } = telemetryRuntime({ app, handlers: [handler], binding, manualTriggers: true });
    await runtime.start();
    const response = await runtime.fetch(new Request("http://localhost/api/orders/o-1", { headers: { traceparent: callerTrace } }));
    await runtime.telemetry.flush();
    await runtime.stop();

    expect(response.status).toBe(200);
    const server = exporter.spans.find(span => span.kind === "server")!;
    const producer = exporter.spans.find(span => span.kind === "producer")!;
    expect(server).toMatchObject({ traceId: "0af7651916cd43dd8448eb211c80319c", parentSpanId: "b7ad6b7169203331", name: "GET /api/orders/:orderId", attributes: { "http.request.method": "GET", "http.route": "/api/orders/:orderId", "http.response.status_code": 200, "holqa.handler.id": "orders.get", "holqa.outcome": "ok" } });
    expect(producer).toMatchObject({ traceId: server.traceId, parentSpanId: server.spanId, name: "send jobs", attributes: { "messaging.destination.name": "jobs", "messaging.message.id": "m-1" } });
    // The published message carries the producer span's context next to its lineage.
    expect(sends[0]?.trace).toMatchObject({ depth: 1, traceparent: `00-${producer.traceId}-${producer.spanId}-01` });
    expect(seen).toEqual([{ traceId: server.traceId, spanId: server.spanId, sampled: true, traceparent: `00-${server.traceId}-${server.spanId}-01` }]);

    const logged = entries.find(entry => entry.message.startsWith("calling the payment service"))!;
    expect(logged).toMatchObject({ message: "calling the payment service with [REDACTED]", authorization: "[REDACTED]", orderId: "o-1", traceId: server.traceId, spanId: server.spanId, handlerId: "orders.get" });
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(exporter.spans)).not.toContain(secret);

    const metrics = exporter.metrics.at(-1)!;
    expect(metrics.find(metric => metric.name === "http.server.request.duration")?.points[0]?.attributes).toEqual({ "http.request.method": "GET", "http.response.status_code": 200, "http.route": "/api/orders/:orderId" });
    expect(metrics.find(metric => metric.name === "holqa.handler.invocations")?.points).toMatchObject([{ attributes: { "holqa.handler.id": "orders.get", "holqa.outcome": "ok", "holqa.trigger.kind": "http.route" }, value: 1 }]);
  });

  it("makes a message's processing span a child of its publisher by default, linked to it", async () => {
    const source = new MemorySource<MessageEnvelope>();
    const { binding } = bindingWith(source);
    const { runtime, exporter } = telemetryRuntime({ app: application([jobs]), handlers: [consumer()], binding });
    await runtime.start();
    source.add("m-1", { format: "holqa.message/1", schemaVersion: 1, payload: "x" }, 0, { correlationId: "c-1", causationId: "inv-0", rootId: "inv-0", depth: 1, traceparent: callerTrace });
    await source.drained();
    await runtime.telemetry.flush();
    await runtime.stop();
    const [span] = exporter.spans;
    expect(span).toMatchObject({ name: "process jobs", kind: "consumer", traceId: "0af7651916cd43dd8448eb211c80319c", parentSpanId: "b7ad6b7169203331", links: [{ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" }], attributes: { "messaging.message.id": "m-1", "holqa.delivery.attempt": 1, "holqa.lineage.depth": 1, "holqa.lineage.root_id": "inv-0" } });
    const metrics = exporter.metrics.at(-1)!;
    expect(metrics.find(metric => metric.name === "messaging.process.duration")?.points[0]?.attributes).toEqual({ "holqa.outcome": "ok", "messaging.destination.name": "jobs", "messaging.operation.name": "process" });
    expect(metrics.find(metric => metric.name === "holqa.queue.pending")?.points).toMatchObject([{ attributes: { "messaging.destination.name": "jobs" }, value: 3 }]);
  });

  it("starts a new trace per delivery with a link when messages are configured as links", async () => {
    const source = new MemorySource<MessageEnvelope>();
    const { binding } = bindingWith(source);
    const { runtime, exporter } = telemetryRuntime({ app: application([jobs]), handlers: [consumer()], binding, telemetry: { messages: "link" } });
    await runtime.start();
    source.add("m-1", { format: "holqa.message/1", schemaVersion: 1, payload: "x" }, 0, { correlationId: "c-1", traceparent: callerTrace });
    await source.drained();
    await runtime.telemetry.flush();
    await runtime.stop();
    const [span] = exporter.spans;
    expect(span?.traceId).not.toBe("0af7651916cd43dd8448eb211c80319c");
    expect(span?.parentSpanId).toBeUndefined();
    expect(span?.links).toEqual([{ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" }]);
  });

  it("keeps lineage and safety limits independent of sampling", async () => {
    const app = application([jobs, scheduleResource("nightly")]);
    const { binding, sends } = bindingWith();
    const handler = scheduleHandler("nightly.run", "nightly", async () => {
      await resolveDriver(app["~holqa"], jobs, "send").send({ format: "holqa.message/1", schemaVersion: 1, payload: "a" }, {});
      await resolveDriver(app["~holqa"], jobs, "send").send({ format: "holqa.message/1", schemaVersion: 1, payload: "b" }, {});
    });
    const { runtime, exporter, entries } = telemetryRuntime({ app, handlers: [handler, consumer()], binding, manualTriggers: true, telemetry: { sampleRatio: 0 }, events: { maxPublications: 1 } });
    await runtime.start();
    const outcome = await runtime.invoke({ handlerId: "nightly.run", metadata: { scheduledTime: "2026-10-18T03:00:00Z" } });
    await runtime.telemetry.flush();
    await runtime.stop();
    // Nothing is recorded, but the publication limit still applies and lineage is still stored.
    expect(exporter.spans).toEqual([]);
    expect(outcome).toMatchObject({ ok: false, blocked: { code: "HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED" } });
    expect(sends).toHaveLength(1);
    expect(sends[0]?.trace).toMatchObject({ rootId: outcome.invocationId, depth: 1 });
    expect(sends[0]?.trace?.traceparent).toEndWith("-00");
    expect(entries.find(entry => entry.message === "invocation failed")).toMatchObject({ traceId: expect.any(String) });
  });

  it("keeps serving when an exporter fails, and reports the failure once", async () => {
    const { binding } = bindingWith();
    const { sink, entries } = recordingSink();
    let calls = 0;
    const runtime = createRuntime({
      app: application([scheduleResource("nightly")]),
      handlers: [scheduleHandler("nightly.run", "nightly", () => "done")],
      binding,
      manualTriggers: true,
      log: sink,
      telemetry: { exporters: [{ name: "collector", exportSpans: async () => {
        calls += 1;
        throw new Error("ECONNREFUSED");
      } }] }
    });
    await runtime.start();
    const outcomes = [await runtime.invoke({ handlerId: "nightly.run", metadata: { scheduledTime: "2026-10-18T03:00:00Z" } })];
    await runtime.telemetry.flush();
    outcomes.push(await runtime.invoke({ handlerId: "nightly.run", metadata: { scheduledTime: "2026-10-18T03:00:00Z" } }));
    await runtime.telemetry.flush();
    await runtime.stop();
    expect(outcomes.map(outcome => outcome.ok)).toEqual([true, true]);
    expect(calls).toBeGreaterThanOrEqual(2);
    const reports = entries.filter(entry => entry.message === "telemetry export failed; the records were dropped");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ level: "warn", code: "HOLQA_TELEMETRY_EXPORT_FAILED", exporter: "collector", signal: "spans", error: "ECONNREFUSED" });
    expect(runtime.stats().telemetry.spansDropped).toBeGreaterThanOrEqual(2);
  });

  it("records nothing and adds no trace fields when telemetry is disabled", async () => {
    const { binding, sends } = bindingWith();
    const { sink, entries } = recordingSink();
    const app = application([jobs, scheduleResource("nightly")]);
    const seen: unknown[] = [];
    const runtime = createRuntime({
      app,
      handlers: [scheduleHandler("nightly.run", "nightly", async (context) => {
        seen.push(context.telemetry);
        await resolveDriver(app["~holqa"], jobs, "send").send({ format: "holqa.message/1", schemaVersion: 1, payload: "a" }, {});
      })],
      binding,
      manualTriggers: true,
      log: sink
    });
    await runtime.start();
    await runtime.invoke({ handlerId: "nightly.run", metadata: { scheduledTime: "2026-10-18T03:00:00Z" } });
    await runtime.stop();
    expect(runtime.telemetry.enabled).toBe(false);
    expect(seen).toEqual([undefined]);
    expect(sends[0]?.trace?.traceparent).toBeUndefined();
    expect(entries.some(entry => "traceId" in entry)).toBe(false);
  });

  it("filters logs by level, offers debug to handlers and exports log records when asked", async () => {
    const { binding } = bindingWith();
    const handler = scheduleHandler("nightly.run", "nightly", (context) => {
      context.log.debug("details");
      context.log.warn("careful", { password: "x" });
    });
    const quiet = telemetryRuntime({ app: application([scheduleResource("nightly")]), handlers: [handler], binding, manualTriggers: true, logLevel: "warn", telemetry: { exportLogs: true } });
    await quiet.runtime.start();
    await quiet.runtime.invoke({ handlerId: "nightly.run", metadata: { scheduledTime: "2026-10-18T03:00:00Z" } });
    await quiet.runtime.telemetry.flush();
    await quiet.runtime.stop();
    expect(quiet.entries.map(entry => entry.message)).toEqual(["careful"]);
    expect(quiet.exporter.logs).toMatchObject([{ severity: "warn", body: "careful", attributes: { password: "[REDACTED]", handlerId: "nightly.run" } }]);
    expect(quiet.exporter.logs[0]?.traceId).toBe(quiet.exporter.spans[0]?.traceId);
  });

  it("starts a new trace for untrusted or malformed trace headers, and records method and status safely", async () => {
    const app = application([apiResource("shop-api")]);
    const handlers = [
      routeHandler("ok.get", "shop-api", "GET", "/ok"),
      routeHandler("missing.get", "shop-api", "GET", "/missing", () => new Response("no", { status: 404 })),
      routeHandler("broken.get", "shop-api", "GET", "/broken", () => new Response("down", { status: 503 }))
    ];
    const untrusted = telemetryRuntime({ app, handlers, telemetry: { acceptTraceparent: false } });
    await untrusted.runtime.start();
    await untrusted.runtime.fetch(new Request("http://localhost/api/ok", { headers: { traceparent: callerTrace } }));
    await untrusted.runtime.fetch(new Request("http://localhost/api/missing"));
    await untrusted.runtime.fetch(new Request("http://localhost/api/broken"));
    await untrusted.runtime.fetch(new Request("http://localhost/api/ok", { method: "PURGE" }));
    await untrusted.runtime.telemetry.flush();
    await untrusted.runtime.stop();
    const [ok, missing, broken, brew] = untrusted.exporter.spans;
    expect(ok?.traceId).not.toBe("0af7651916cd43dd8448eb211c80319c");
    expect(ok?.parentSpanId).toBeUndefined();
    expect(ok?.attributes["url.path"]).toBeUndefined();
    // A 4xx is the caller's error; a 5xx is the server's.
    expect(missing?.status).toEqual({ code: "unset" });
    expect(broken?.status).toEqual({ code: "error", message: "HTTP 503" });
    expect(brew).toMatchObject({ name: "HTTP", attributes: { "http.request.method": "_OTHER", "http.request.method_original": "PURGE", "http.response.status_code": 405 } });
    const methods = untrusted.exporter.metrics.at(-1)!.find(metric => metric.name === "http.server.request.duration")!.points.map(point => point.attributes["http.request.method"]);
    expect(methods).not.toContain("PURGE");

    const trusting = telemetryRuntime({ app, handlers });
    await trusting.runtime.start();
    await trusting.runtime.fetch(new Request("http://localhost/api/ok", { headers: { traceparent: callerTrace.toUpperCase() } }));
    await trusting.runtime.telemetry.flush();
    await trusting.runtime.stop();
    expect(trusting.exporter.spans[0]?.traceId).not.toBe("0af7651916cd43dd8448eb211c80319c");
  });

  it("never lets a redacted secret corrupt an entry's level or time", async () => {
    const app = application([scheduleResource("nightly")], [configEntry("API_TOKEN", nonEmptyString, { sensitive: true })]);
    const { sink, entries } = recordingSink();
    const runtime = createRuntime({
      app,
      handlers: [scheduleHandler("nightly.run", "nightly", context => context.log.info("info about 2026"))],
      binding: { name: "b", capabilities: { schedule: { overlap: ["skip"] } }, drivers: {}, config: () => "info" },
      manualTriggers: true,
      log: sink,
      clock: () => new Date("2026-10-20T10:00:00.000Z")
    });
    await runtime.start();
    await runtime.invoke({ handlerId: "nightly.run", metadata: { scheduledTime: "2026-10-18T03:00:00Z" } });
    await runtime.stop();
    const entry = entries.find(candidate => candidate.message.includes("about"))!;
    expect(entry).toMatchObject({ level: "info", time: "2026-10-20T10:00:00.000Z", message: "[REDACTED] about 2026" });
  });

  it("replaces invalid identifiers from a custom generator", async () => {
    const exporter = recordingExporter();
    const runtime = createRuntime({ app: application([scheduleResource("nightly")]), handlers: [scheduleHandler("nightly.run", "nightly", () => undefined)], binding: { name: "b", capabilities: { schedule: { overlap: ["skip"] } }, drivers: {}, config: () => undefined }, manualTriggers: true, log: () => {}, telemetry: { exporters: [exporter], ids: { traceId: () => "not-hex", spanId: () => "0".repeat(16) } } });
    await runtime.start();
    await runtime.invoke({ handlerId: "nightly.run", metadata: { scheduledTime: "2026-10-18T03:00:00Z" } });
    await runtime.telemetry.flush();
    await runtime.stop();
    expect(exporter.spans[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(exporter.spans[0]?.spanId).not.toBe("0".repeat(16));
  });

  it("rejects invalid telemetry and log settings at creation", () => {
    expect(() => createRuntime({ app: application([]), handlers: [], telemetry: { sampleRatio: 2, messages: "child" as never, limits: { maxQueueSize: 0 } }, logLevel: "loud" as never })).toThrow(expect.objectContaining({
      diagnostics: [
        expect.objectContaining({ code: "HOLQA_TELEMETRY_CONFIG_INVALID", message: "\"telemetry.sampleRatio\" must be a number from 0 to 1." }),
        expect.objectContaining({ code: "HOLQA_TELEMETRY_CONFIG_INVALID", message: "\"telemetry.messages\" must be \"parent\" or \"link\"." }),
        expect.objectContaining({ code: "HOLQA_TELEMETRY_CONFIG_INVALID", message: "\"telemetry.limits.maxQueueSize\" must be an integer of at least 1." }),
        expect.objectContaining({ code: "HOLQA_RUNTIME_START_FAILED" })
      ]
    }));
    expect(() => createRuntime({ app: application([]), handlers: [], telemetry: { exportLog: true, acceptTraceparent: "yes", ids: {} } as never })).toThrow(expect.objectContaining({
      diagnostics: [
        expect.objectContaining({ message: "\"telemetry.exportLog\" is not a telemetry setting." }),
        expect.objectContaining({ message: "\"telemetry.acceptTraceparent\" must be a boolean." }),
        expect.objectContaining({ message: "\"telemetry.ids\" must provide traceId and spanId functions." })
      ]
    }));
  });
});