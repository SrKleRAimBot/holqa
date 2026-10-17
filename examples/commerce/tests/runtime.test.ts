import type { Runtime } from "@holqa/experiment-runtime-bun";

import { createRuntime } from "@holqa/experiment-runtime-bun";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "bun:test";

import { sign } from "@/src/payments/payment-webhook.handler";
import { appRoot } from "@/tests/load";

/** A test-only webhook secret; not a real credential. */
const webhookSecret = "test-webhook-secret-0001";

/** The response fields the scenario inspects. */
interface ResponseBody {
  readonly orderId?: unknown;
  readonly status?: unknown;
  readonly total?: unknown;
}

/** The runtime under test, shared by the ordered scenario below. */
let runtime: Runtime;

/**
 * Sends a JSON request to the running application.
 *
 * @param method - The HTTP method.
 * @param path - The request path, including `/api`.
 * @param body - An optional JSON body.
 * @returns The status and parsed JSON body.
 */
async function call(method: string, path: string, body?: unknown): Promise<{ readonly status: number; readonly body: ResponseBody }> {
  const response = await runtime.fetch(new Request(`http://commerce.local${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } })
  }));
  return { status: response.status, body: await response.json() as ResponseBody };
}

/**
 * Posts a signed payment notification.
 *
 * @param event - The provider event.
 * @param secret - The secret to sign with.
 * @returns The webhook response.
 */
async function postPayment(event: Record<string, unknown>, secret = webhookSecret): Promise<{ readonly status: number; readonly body: ResponseBody }> {
  const payload = JSON.stringify(event);
  return call("POST", "/api/webhooks/payments", { payload, signature: await sign(secret, payload) });
}

beforeAll(async () => {
  runtime = createRuntime({ root: appRoot, env: { PAYMENT_WEBHOOK_SECRET: webhookSecret } });
  const loaded = await runtime.load();
  expect(loaded.ok).toBe(true);
});

afterAll(async () => {
  await runtime.dispose();
});

describe("commerce on the experiment runtime", () => {
  let orderId = "";

  it("rejects malformed requests at the trust boundary", async () => {
    expect((await call("POST", "/api/orders", { customerEmail: "not-an-email", lines: [] })).status).toBe(400);
    expect((await call("GET", "/api/orders/not-a-uuid")).status).toBe(400);
  });

  it("places an order, fulfils it through the queue and stores an invoice", async () => {
    const placed = await call("POST", "/api/orders", { customerEmail: "ada@example.com", lines: [{ sku: "MUG-001", quantity: 2 }] });
    expect(placed.status).toBe(202);
    expect(placed.body.total).toBe(2400);
    orderId = String(placed.body.orderId);

    await runtime.idle();
    expect(runtime.queue("order-fulfillment").delivered).toBe(1);
    const invoice = runtime.getObject("invoices", `invoices/${orderId}.json`);
    expect(JSON.parse(new TextDecoder().decode(invoice))).toMatchObject({ orderId, total: 2400 });
    expect((await call("GET", `/api/orders/${orderId}`)).body).toEqual({ orderId, status: "pending", total: 2400 });
  });

  it("applies a verified payment once, even when the provider delivers it twice", async () => {
    const event = { eventId: "evt-1", orderId, status: "succeeded", amount: 2400 };
    expect((await postPayment(event)).status).toBe(202);
    expect((await postPayment(event)).status).toBe(202);
    await runtime.idle();
    expect(runtime.queue("payment-events").delivered).toBe(2);
    expect((await call("GET", `/api/orders/${orderId}`)).body.status).toBe("paid");
  });

  it("rejects forged and malformed payment notifications", async () => {
    expect((await postPayment({ eventId: "evt-2", orderId, status: "failed", amount: 0 }, "wrong-secret-0000000000")).status).toBe(401);
    expect((await postPayment({ eventId: "evt-3" })).status).toBe(400);
    await runtime.idle();
    expect((await call("GET", `/api/orders/${orderId}`)).body.status).toBe("paid");
  });

  it("runs the schedule handler for an explicit scheduled time", async () => {
    await runtime.invoke("maintenance.reconcile", undefined, { metadata: { scheduledTime: "2026-10-18T03:00:00.000Z" } });
  });

  it("starts each generation with fresh module state after a reload", async () => {
    const reloaded = await runtime.reload();
    expect(reloaded.ok).toBe(true);
    expect((await call("GET", `/api/orders/${orderId}`)).status).toBe(404);
  });
});