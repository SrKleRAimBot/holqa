import type { TestApp } from "@holqa/testing";

import {
  createTestApp,
  spanTree
} from "@holqa/testing";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from "bun:test";
import app from "@/app/infra";
import {
  chargeOrder,
  declined,
  placeOrder,
  receiptStored
} from "@/app/src/orders.handler";

/** The secret token the consumer uses; it must never appear in logs or telemetry. */
const token = "pay-tok-7f3a9c";

/** The application under test. */
let shop: TestApp;

beforeEach(async () => {
  declined.clear();
  shop = await createTestApp({ app, handlers: [placeOrder, chargeOrder, receiptStored], env: { PAYMENT_TOKEN: token }, telemetry: { exportLogs: true } });
});

afterEach(async () => {
  await shop.dispose();
});

/**
 * Places an order over HTTP and runs everything it causes.
 *
 * @param orderId - Identifies the order in logs and the receipt key.
 * @returns The response.
 */
async function placeAndSettle(orderId: string): Promise<Response> {
  const response = await shop.fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId, amountCents: 1_250 }) });
  await shop.drain();
  await shop.flushTelemetry();
  return response;
}

describe("observability", () => {
  it("correlates an HTTP request, the message it publishes, its processing and the object it writes in one trace", async () => {
    const response = await placeAndSettle("o-1");
    expect(response.status).toBe(202);
    const [server] = shop.telemetry.spans({ kind: "server" });
    expect(spanTree(shop.telemetry.trace(server!.traceId))).toEqual([
      { name: "POST /api/orders", kind: "server", status: "ok", children: [
        { name: "send orders", kind: "producer", status: "ok", children: [
          { name: "process orders", kind: "consumer", status: "ok", children: [
            { name: "put receipts", kind: "client", status: "ok", children: [
              { name: "process receipts", kind: "consumer", status: "ok", children: [] }
            ] }
          ] }
        ] }
      ] }
    ]);
  });

  it("identifies every execution in its logs: application, handler, invocation, correlation, lineage and trace", async () => {
    await placeAndSettle("o-2");
    const finished = shop.logs.filter(entry => entry.message === "invocation completed");
    expect(finished.map(({ handlerId }) => handlerId)).toEqual(["orders.place", "orders.charge", "receipts.stored"]);
    const [place, charge, stored] = finished;
    const { correlationId, traceId, invocationId: placed } = place!;
    for (const entry of finished)
      expect(entry).toMatchObject({ application: "observability", correlationId, traceId, invocationId: expect.any(String), spanId: expect.any(String) });
    expect(charge).toMatchObject({ causationId: placed, depth: 1, triggerKind: "queue.message" });
    const { invocationId: charged } = charge!;
    expect(stored).toMatchObject({ causationId: charged, depth: 2, triggerKind: "bucket.object-created" });
  });

  it("never leaks the declared secret's value into logs, spans or exported log records", async () => {
    await placeAndSettle("o-3");
    const charging = shop.logs.find(entry => entry.message.startsWith("charging with token"));
    expect(charging).toMatchObject({ message: "charging with token [REDACTED]", authorization: "[REDACTED]", orderId: "o-3" });
    const everything = JSON.stringify([shop.logs, shop.telemetry.spans(), shop.telemetry.logs(), shop.telemetry.metrics()]);
    expect(everything).not.toContain(token);
    expect(shop.telemetry.logs().find(record => record.body.startsWith("charging"))).toMatchObject({ severity: "info", traceId: expect.any(String), spanId: expect.any(String) });
  });

  it("shows retries, the failure and the dead letter in spans and metrics", async () => {
    declined.add("o-4");
    await placeAndSettle("o-4");
    const attempts = shop.telemetry.spans({ name: "process orders" });
    expect(attempts.map(span => [span.attributes["holqa.delivery.attempt"], span.status.code])).toEqual([[1, "error"], [2, "error"], [3, "error"]]);
    expect(attempts[0]!.events).toMatchObject([{ name: "exception", attributes: { "exception.message": "The payment provider declined order o-4." } }]);
    expect(shop.telemetry.metric("holqa.delivery.retries", { "messaging.destination.name": "orders" })).toBe(2);
    expect(shop.telemetry.metric("holqa.delivery.dead_letters", { "messaging.destination.name": "orders" })).toBe(1);
    expect(shop.telemetry.metric("holqa.handler.failures", { "holqa.handler.id": "orders.charge", "error.type": "HOLQA_HANDLER_FAILED" })).toBe(3);
  });

  it("keeps metric attributes free of identifiers", async () => {
    await placeAndSettle("o-5");
    const attributeKeys = new Set(shop.telemetry.metrics().flatMap(metric => metric.points.flatMap(point => Object.keys(point.attributes))));
    for (const forbidden of ["messaging.message.id", "holqa.invocation.id", "url.path", "orderId", "holqa.object.key"])
      expect(attributeKeys.has(forbidden)).toBe(false);
  });
});