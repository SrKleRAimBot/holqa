import { serializeManifest } from "@holqa/experiment-compiler";
import {
  describe,
  expect,
  it
} from "bun:test";

import { compileExample } from "@/tests/load";

describe("commerce manifest", () => {
  it("compiles without errors and lists every resource and handler", async () => {
    const result = await compileExample();
    const manifest = result.manifest!;
    expect(result.failures).toEqual([]);
    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(manifest.resources.map(resource => `${resource.kind}:${resource.id}`)).toEqual([
      "bucket:invoices",
      "schedule:nightly-reconciliation",
      "queue:order-fulfillment",
      "queue:payment-events",
      "http.api:storefront-api"
    ]);
    expect(manifest.handlers.map(handler => handler.id)).toEqual([
      "catalog.list",
      "invoices.created",
      "maintenance.reconcile",
      "orders.fulfil",
      "orders.get",
      "orders.place",
      "payments.apply",
      "payments.webhook"
    ]);
  });

  it("is deterministic and contains no absolute paths or secret values", async () => {
    const first = serializeManifest((await compileExample()).manifest!);
    const second = serializeManifest((await compileExample()).manifest!);
    expect(first).toBe(second);
    expect(first).not.toContain(import.meta.dir);
    expect(first).toContain("PAYMENT_WEBHOOK_SECRET");
  });
});