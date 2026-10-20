import type { TestApp } from "@/app/create-test-app";

import orders, { handlers } from "@test/fixtures/orders";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import { createTestApp } from "@/app/create-test-app";
import { spanTree } from "@/telemetry/memory-telemetry";

/** Test apps to dispose of after each test. */
const apps: TestApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.dispose();
});

/**
 * Creates a test app of the order pipeline.
 *
 * @param options - Extra settings.
 * @returns The started app.
 */
async function start(options: Partial<Parameters<typeof createTestApp>[0]> = {}): Promise<TestApp> {
  const app = await createTestApp({ app: orders, handlers, startTime: "2026-10-20T10:00:00.000Z", ...options });
  apps.push(app);
  return app;
}

describe("createTestApp telemetry", () => {
  it("records an HTTP request, the message it publishes, its processing and the object it writes as one trace", async () => {
    const app = await start();
    const response = await app.fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: "o-1" }) });
    expect(response.status).toBe(202);
    await app.flush();
    await app.flushTelemetry();

    const [server] = app.telemetry.spans({ kind: "server" });
    expect(spanTree(app.telemetry.trace(server!.traceId))).toEqual([
      { name: "POST /api/orders", kind: "server", status: "ok", children: [
        { name: "send orders", kind: "producer", status: "ok", children: [
          { name: "process orders", kind: "consumer", status: "ok", children: [
            { name: "head receipts", kind: "client", status: "ok", children: [] },
            { name: "put receipts", kind: "client", status: "ok", children: [
              { name: "process receipts", kind: "consumer", status: "ok", children: [] }
            ] }
          ] }
        ] }
      ] }
    ]);
    // Logs of every invocation of the chain carry the trace, next to the lineage.
    const finished = app.logs.filter(entry => entry.message === "invocation completed");
    expect(finished.map(({ traceId }) => traceId)).toEqual([server!.traceId, server!.traceId, server!.traceId]);
    expect(app.telemetry.metric("holqa.handler.invocations", { "holqa.outcome": "ok" })).toBe(3);
    expect(app.telemetry.metric("http.server.request.duration", { "http.route": "/api/orders", "http.response.status_code": 202 })).toBe(1);
    expect(app.telemetry.resource()?.attributes["service.name"]).toBe("orders");
  });

  it("records retries and dead letters as failed processing spans and reliability metrics", async () => {
    const app = await start();
    app.failNext("orders.process", { times: 3, error: new Error("payment service down") });
    await app.send("orders", { orderId: "o-2" });
    await app.drain();
    await app.flushTelemetry();
    const processing = app.telemetry.spans({ name: "process orders" });
    expect(processing.map(span => [span.status.code, span.attributes["holqa.delivery.attempt"]])).toEqual([["error", 1], ["error", 2], ["error", 3]]);
    expect(processing[0]!.events[0]).toMatchObject({ name: "exception", attributes: { "exception.message": "payment service down" } });
    expect(app.telemetry.metric("holqa.delivery.retries", { "messaging.destination.name": "orders" })).toBe(2);
    expect(app.telemetry.metric("holqa.delivery.dead_letters", { "holqa.settlement": "dead_lettered" })).toBe(1);
    expect(app.telemetry.metric("holqa.handler.failures", { "error.type": "HOLQA_HANDLER_FAILED" })).toBe(3);
    expect(app.telemetry.metric("holqa.queue.pending", { "messaging.destination.name": "orders" })).toBe(0);
  });

  it("produces the same identifiers on every run", async () => {
    const first = await start();
    await first.fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: "o-3" }) });
    await first.flush();
    await first.flushTelemetry();
    const recorded = first.telemetry.spans().map(span => [span.traceId, span.spanId, span.name]);
    // An application instance is bound to one runtime at a time.
    await first.dispose();
    const second = await start();
    await second.fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: "o-3" }) });
    await second.flush();
    await second.flushTelemetry();
    expect(second.telemetry.spans().map(span => [span.traceId, span.spanId, span.name])).toEqual(recorded);
  });
});