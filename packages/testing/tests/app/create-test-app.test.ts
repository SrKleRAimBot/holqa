import type { TestApp } from "@/app/create-test-app";

import { existsSync } from "node:fs";
import { diagnosticsOf } from "@holqa/core";
import orders, { handlers } from "@test/fixtures/orders";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from "bun:test";

import { createTestApp } from "@/app/create-test-app";

/** The test app of the current test. */
let app: TestApp;

beforeEach(async () => {
  app = await createTestApp({ app: orders, handlers, startTime: "2026-10-18T09:30:00.000Z" });
});

afterEach(async () => {
  await app.dispose();
});

/**
 * Places an order over HTTP.
 *
 * @param orderId - The order's identifier.
 * @returns The response status and the correlation identifier the runtime assigned.
 */
async function placeOrder(orderId: string): Promise<{ readonly status: number; readonly correlationId: string }> {
  const response = await app.fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId }) });
  return { status: response.status, correlationId: response.headers.get("x-correlation-id") ?? "" };
}

describe("createTestApp", () => {
  it("runs a request, the message it sends and the object event that follows as one trace", async () => {
    const { status, correlationId } = await placeOrder("o-1");
    expect(status).toBe(202);
    await app.flush();

    const trace = app.trace(correlationId);
    expect(trace.map(record => `${record.handlerId}:${record.outcome}`)).toEqual(["orders.place:ok", "orders.process:ok", "receipts.written:ok"]);
    const [place, process, written] = trace;
    expect(place!.emitted).toEqual([{ type: "queue.message", resourceId: "orders", messageId: expect.any(String) }]);
    expect(process).toMatchObject({ causationId: place!.invocationId, trigger: "queue.message", attempt: 1, emitted: [{ type: "object.created", resourceId: "receipts", key: "receipts/o-1.json" }] });
    expect(written).toMatchObject({ causationId: process!.invocationId, trigger: "bucket.object-created" });
    expect(JSON.parse(await app.read("receipts", "receipts/o-1.json") ?? "null")).toEqual({ orderId: "o-1", attempt: 1 });
  });

  it("retries a failed message after its backoff in virtual time, without waiting for it", async () => {
    app.failNext("orders.process");
    const { messageId } = await app.send("orders", { orderId: "o-2" });
    await app.flush();
    expect(app.messages("orders")).toMatchObject([{ messageId, state: "delayed", attempts: 1, lastError: { code: "HOLQA_HANDLER_FAILED" } }]);
    await app.advance(4_999);
    expect(app.invocations({ handlerId: "orders.process" })).toHaveLength(1);
    await app.advance(1);
    expect(app.invocations({ handlerId: "orders.process" }).map(record => [record.outcome, record.attempt])).toEqual([["failed", 1], ["ok", 2]]);
    expect(app.clock.now()).toBe(Date.parse("2026-10-18T09:30:05.000Z"));
  });

  it("dead-letters a message whose attempts all fail, and redrives it", async () => {
    app.failNext("orders.process", { times: 3, error: new Error("payment service down") });
    const { messageId } = await app.send("orders", { orderId: "o-3" });
    await app.drain();
    expect(app.deadLetters("orders")).toMatchObject([{ messageId, attempts: 3, lastError: { code: "HOLQA_HANDLER_FAILED" } }]);
    expect(app.invocations({ handlerId: "orders.process", outcome: "failed" }).map(record => record.attempt)).toEqual([1, 2, 3]);
    const failure = app.logs.find(entry => entry.message === "invocation failed");
    expect(failure).toMatchObject({ error: { message: "payment service down" } });
    expect(app.redrive("orders")).toBe(1);
    await app.flush();
    expect(app.objects("receipts").map(object => object.key)).toEqual(["receipts/o-3.json"]);
  });

  it("injects failures only into matching invocations", async () => {
    app.failNext("orders.process", { when: input => (input as { readonly orderId?: unknown }).orderId === "bad" });
    await app.send("orders", { orderId: "good" });
    await app.send("orders", { orderId: "bad" });
    await app.flush();
    expect(app.invocations({ handlerId: "orders.process" }).map(record => record.outcome).sort()).toEqual(["failed", "ok"]);
  });

  it("delivers duplicates with the same message identifier, so idempotency can be tested", async () => {
    const { messageId } = await app.send("orders", { orderId: "o-4" });
    await app.flush();
    expect(app.duplicate("orders", messageId)).toBe(true);
    await app.flush();
    const deliveries = app.invocations({ handlerId: "orders.process" });
    expect(deliveries).toHaveLength(2);
    expect(app.logs.filter(entry => entry.message === "duplicate order skipped")).toMatchObject([{ messageId }]);
    expect(app.objects("receipts")).toHaveLength(1);
    const [event] = app.events("receipts");
    expect(app.duplicateEvent("receipts", "receipts.written", event!.event.id)).toBe(true);
    await app.flush();
    expect(app.invocations({ handlerId: "receipts.written" })).toHaveLength(2);
  });

  it("fires schedules as virtual time passes and runs manual triggers", async () => {
    await app.send("orders", { orderId: "o-5" });
    await app.flush();
    await app.advance(30 * 60_000);
    expect(app.runs("cleanup")).toMatchObject([{ status: "succeeded", trigger: "cron", scheduledTime: "2026-10-18T10:00:00.000Z" }]);
    expect(app.objects("receipts")).toEqual([]);
    const run = await app.trigger("cleanup");
    expect(run).toMatchObject({ status: "succeeded", trigger: "manual" });
  });

  it("invokes background handlers directly with generated metadata", async () => {
    const outcome = await app.invoke("orders.process", { orderId: "o-6" }, { attempt: 2, correlationId: "manual-1" });
    expect(outcome).toMatchObject({ ok: true, correlationId: "manual-1", emitted: [{ type: "object.created", key: "receipts/o-6.json" }] });
    expect(JSON.parse(await app.read("receipts", "receipts/o-6.json") ?? "null")).toEqual({ orderId: "o-6", attempt: 2 });
    // The consumer validates its input itself; the runtime reports that as a handler failure caused by HOLQA_INPUT_INVALID.
    expect(await app.invoke("orders.process", { orderId: 6 })).toMatchObject({ ok: false, failure: { code: "HOLQA_HANDLER_FAILED", diagnostics: [{ code: "HOLQA_HANDLER_FAILED" }, { code: "HOLQA_INPUT_INVALID" }] } });
    expect(await app.invoke("missing.handler")).toMatchObject({ ok: false, failure: { code: "HOLQA_HANDLER_NOT_FOUND" } });
    const codes = await app.invoke("orders.place", {}).then(() => [], (error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
    expect(codes).toEqual(["HOLQA_OPERATION_INVALID"]);
  });

  it("validates messages sent by the test like a producer would", async () => {
    const codes = await app.send("orders", { orderId: 1 }).then(() => [], (error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
    expect(codes).toEqual(["HOLQA_INPUT_INVALID"]);
    const missing = await app.send("missing", {}).then(() => [], (error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
    expect(missing).toEqual(["HOLQA_RESOURCE_NOT_FOUND"]);
    const delayed = await app.send("orders", { orderId: "o-7" }, { delaySeconds: 60 });
    await app.flush();
    expect(app.messages("orders", ["delayed"]).map(message => message.messageId)).toEqual([delayed.messageId]);
    await app.drain();
    expect(app.messages("orders", ["acknowledged"])).toHaveLength(1);
  });

  it("stores objects that trigger handlers", async () => {
    await app.put("receipts", "receipts/manual.json", "{}", { contentType: "application/json" });
    await app.flush();
    expect(app.invocations({ handlerId: "receipts.written" })).toMatchObject([{ outcome: "ok" }]);
  });
});

describe("test app lifecycle", () => {
  it("refuses a second running test app for the same application instance", async () => {
    const codes = await createTestApp({ app: orders, handlers }).then(async (second) => {
      await second.dispose();
      return [];
    }, (error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
    expect(codes).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_RUNTIME_ALREADY_BOUND"]);
    expect(await app.send("orders", { orderId: "still-running" })).toMatchObject({ messageId: expect.any(String) });
  });

  it("removes its temporary state on dispose, can be disposed twice, and the next app starts clean", async () => {
    await app.send("orders", { orderId: "o-8" });
    const { directory } = app;
    expect(existsSync(directory)).toBe(true);
    await app.dispose();
    await app.dispose();
    expect(existsSync(directory)).toBe(false);
    app = await createTestApp({ app: orders, handlers });
    expect(app.messages("orders")).toEqual([]);
  });

  it("rejects values that are not applications", async () => {
    const codes = await createTestApp({ app: {}, handlers: [] }).then(() => [], (error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
    expect(codes).toEqual(["HOLQA_APP_INVALID"]);
    const time = await createTestApp({ app: orders, handlers, startTime: "not a date" }).then(() => [], (error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
    expect(time).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });
});