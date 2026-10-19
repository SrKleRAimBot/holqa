import type { TestApp } from "@holqa/testing";

import { diagnosticsOf } from "@holqa/core";
import { createTestApp } from "@holqa/testing";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from "bun:test";
import app from "@/app/infra";
import { removeOldUploads } from "@/app/src/cleanup.handler";
import {
  getOrder,
  placeOrder,
  processOrder
} from "@/app/src/orders.handler";
import { recordUpload } from "@/app/src/uploads.handler";

/** The application under test, with isolated local resources and a virtual clock. */
let pipeline: TestApp;

beforeEach(async () => {
  pipeline = await createTestApp({ app, handlers: [placeOrder, getOrder, processOrder, recordUpload, removeOldUploads], startTime: "2026-10-18T09:30:00.000Z" });
});

afterEach(async () => {
  await pipeline.dispose();
});

/**
 * Places an order over the application's HTTP API.
 *
 * @param body - The request body.
 * @returns The response.
 */
async function place(body: unknown): Promise<Response> {
  return pipeline.fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * Reads an order's receipt over HTTP.
 *
 * @param orderId - The order whose receipt to read.
 * @returns The status and body.
 */
async function receiptOf(orderId: string): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await pipeline.fetch(`/api/orders/${orderId}`);
  return { status: response.status, body: await response.json() };
}

describe("order pipeline", () => {
  it("processes an order in the background and traces it from the request to the receipt", async () => {
    const response = await place({ orderId: "123", totalCents: 4200 });
    expect(response.status).toBe(202);
    await pipeline.flush();
    expect(await receiptOf("123")).toEqual({ status: 200, body: { orderId: "123", totalCents: 4200, messageId: expect.any(String), attempt: 1 } });
    const trace = pipeline.trace(response.headers.get("x-correlation-id")!);
    expect(trace.map(record => record.handlerId)).toEqual(["orders.place", "orders.process"]);
    expect(trace[1]).toMatchObject({ causationId: trace[0]!.invocationId, emitted: [{ type: "object.created", resourceId: "receipts", key: "receipts/123.json" }] });
  });

  it("retries a failed attempt after its backoff, in virtual time", async () => {
    pipeline.failNext("orders.process", { error: new Error("inventory service unavailable") });
    await place({ orderId: "retry" });
    await pipeline.flush();
    expect(pipeline.messages("orders")).toMatchObject([{ state: "delayed", attempts: 1, lastError: { code: "HOLQA_HANDLER_FAILED" } }]);
    await pipeline.advance(4_999);
    expect((await receiptOf("retry")).status).toBe(404);
    await pipeline.advance(1);
    expect(await receiptOf("retry")).toMatchObject({ status: 200, body: { attempt: 2 } });
    expect(pipeline.logs.find(entry => entry.message === "invocation failed")).toMatchObject({ handlerId: "orders.process", attempt: 1, error: { message: "inventory service unavailable" } });
  });

  it("dead-letters an order whose attempts all fail, and processes it after a redrive", async () => {
    pipeline.failNext("orders.process", { times: 3 });
    await place({ orderId: "poison" });
    await pipeline.drain();
    expect(pipeline.deadLetters("orders")).toMatchObject([{ attempts: 3, payload: { orderId: "poison" }, lastError: { code: "HOLQA_HANDLER_FAILED" } }]);
    expect(pipeline.invocations({ handlerId: "orders.process" }).map(record => record.attempt)).toEqual([1, 2, 3]);
    // 5 s, then 10 s of backoff passed without the test waiting for them.
    expect(pipeline.clock.now()).toBe(Date.parse("2026-10-18T09:30:15.000Z"));
    expect((await receiptOf("poison")).status).toBe(404);
    pipeline.redrive("orders");
    await pipeline.flush();
    expect((await receiptOf("poison")).status).toBe(200);
  });

  it("tolerates duplicate deliveries of messages and object events", async () => {
    const { messageId } = await pipeline.send("orders", { orderId: "dup" });
    await pipeline.flush();
    pipeline.duplicate("orders", messageId);
    await pipeline.flush();
    expect(pipeline.invocations({ handlerId: "orders.process" })).toHaveLength(2);
    expect(pipeline.logs.filter(entry => entry.message === "order already processed")).toMatchObject([{ messageId }]);
    expect(pipeline.objects("receipts").map(object => object.key)).toEqual(["receipts/dup.json"]);

    await pipeline.put("uploads", "sample.pdf", "%PDF-1.7", { contentType: "application/pdf" });
    await pipeline.flush();
    const [upload] = pipeline.events("uploads");
    pipeline.duplicateEvent("uploads", "uploads.received", upload!.event.id);
    await pipeline.flush();
    expect(pipeline.invocations({ handlerId: "uploads.received", outcome: "ok" })).toHaveLength(2);
    expect(JSON.parse(await pipeline.read("receipts", "uploads/sample.pdf.json") ?? "null")).toEqual({ key: "sample.pdf", size: 8, contentType: "application/pdf", eventId: upload!.event.id });
  });

  it("removes old uploads on the hourly schedule", async () => {
    await pipeline.put("uploads", "old.pdf", "old");
    await pipeline.flush();
    await pipeline.advance(25 * 3_600_000);
    expect(pipeline.objects("uploads")).toEqual([]);
    const runs = pipeline.runs("cleanup");
    expect(runs).toHaveLength(25);
    expect(runs.every(run => run.status === "succeeded" && run.trigger === "cron")).toBe(true);
    expect(pipeline.logs.filter(entry => entry.message === "old uploads removed").map(({ removed }) => removed)).toContain(1);
  });

  it("rejects invalid orders at every boundary", async () => {
    const response = await place({ orderId: "has spaces" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "HOLQA_INPUT_INVALID" } });
    const codes = await pipeline.send("orders", { orderId: 1 }).then(() => [], (error: unknown) => diagnosticsOf(error).map(diagnostic => diagnostic.code));
    expect(codes).toEqual(["HOLQA_INPUT_INVALID"]);
  });
});