import { existsSync } from "node:fs";

import orders, { handlers } from "@test/fixtures/orders";
import {
  describe,
  expect,
  it
} from "bun:test";

import { createTestApp } from "@/app/create-test-app";

describe("createTestApp persistence", () => {
  it("runs the same pipeline in memory, with retries in virtual time and no state on disk", async () => {
    const app = await createTestApp({ app: orders, handlers, persistence: "memory" });
    try {
      expect(app.directory).toBe(":memory:");
      expect(existsSync(app.directory)).toBe(false);
      app.failNext("orders.process");
      await app.send("orders", { orderId: "m-1" });
      await app.flush();
      expect(app.messages("orders")).toMatchObject([{ state: "delayed", attempts: 1 }]);
      await app.advance(5_000);
      expect(JSON.parse(await app.read("receipts", "receipts/m-1.json") ?? "null")).toEqual({ orderId: "m-1", attempt: 2 });
    } finally {
      await app.dispose();
    }
  });
});