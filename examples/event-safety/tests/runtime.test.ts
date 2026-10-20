import type { TestApp } from "@holqa/testing";

import { createTestApp } from "@holqa/testing";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from "bun:test";
import app from "@/app/infra";
import { makeThumbnail } from "@/app/src/images.handler";
import {
  charged,
  chargePayment
} from "@/app/src/payments.handler";
import {
  sendFollowup,
  sendReminder
} from "@/app/src/reminders.handler";
import {
  fulfilShipment,
  inStock
} from "@/app/src/shipments.handler";

/** The application under test. */
let safety: TestApp;

beforeEach(async () => {
  charged.length = 0;
  inStock.clear();
  safety = await createTestApp({
    app,
    handlers: [fulfilShipment, sendReminder, sendFollowup, makeThumbnail, chargePayment],
    events: { maxDepth: 6, maxEventsPerOperation: 50 }
  });
});

afterEach(async () => {
  await safety.dispose();
});

describe("event safety at run time", () => {
  it("stops the unbounded reminder cycle at the depth limit with a terminal dead letter", async () => {
    await safety.send("reminders", { customerId: "c-1", count: 0 });
    await safety.drain();
    const chain = [...safety.invocations({ handlerId: "reminders.send" }), ...safety.invocations({ handlerId: "followups.send" })].sort((left, right) => left.depth - right.depth);
    expect(chain.map(record => record.depth)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(chain.at(-1)).toMatchObject({ outcome: "failed", code: "HOLQA_EVENT_DEPTH_EXCEEDED" });
    const deadLetters = [...safety.deadLetters("reminders"), ...safety.deadLetters("followups")];
    expect(deadLetters).toMatchObject([{ attempts: 1, lastError: { code: "HOLQA_EVENT_DEPTH_EXCEEDED" } }]);
    expect(safety.lineage(chain.at(-1)!.invocationId).map(record => record.handlerId)).toEqual(["reminders.send", "followups.send", "reminders.send", "followups.send", "reminders.send", "followups.send", "reminders.send"]);
  });

  it("lets the intentional shipment cycle run to its end, in virtual time", async () => {
    await safety.send("shipments", { orderId: "o-1", checks: 0 });
    await safety.drain();
    expect(safety.invocations({ handlerId: "shipments.fulfil" }).map(record => record.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(safety.deadLetters("shipments")).toEqual([]);
    inStock.add("o-2");
    await safety.send("shipments", { orderId: "o-2", checks: 0 });
    await safety.flush();
    expect(safety.logs.some(entry => entry.message === "shipped")).toBe(true);
  });

  it("writes thumbnails without triggering itself again", async () => {
    await safety.put("images", "uploads/cat.png", "png", { contentType: "image/png" });
    await safety.flush();
    expect(safety.objects("images").map(object => object.key)).toEqual(["thumbnails/cat.png", "uploads/cat.png"]);
    expect(safety.invocations({ handlerId: "images.thumbnail" })).toHaveLength(1);
  });

  it("charges a payment once, however often it is delivered", async () => {
    const { messageId } = await safety.send("payments", { paymentId: "p-1", amountCents: 500 });
    await safety.send("payments", { paymentId: "p-1", amountCents: 500 });
    await safety.flush();
    safety.duplicate("payments", messageId);
    await safety.flush();
    expect(charged).toEqual(["p-1"]);
  });
});