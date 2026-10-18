import type {
  LogEntry,
  RunningServer
} from "@holqa/runtime-bun";
import type {
  InferProcedureContract,
  InferRouteContract
} from "@holqa/sdk";

import type { placeOrder } from "@/app/src/orders.handler";

import type { cancelOrder } from "@/app/src/rpc.handler";
import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";

import {
  dirname,
  join
} from "node:path";
import {
  createRuntime,
  loadCompiledApplication,
  serve
} from "@holqa/runtime-bun";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
  setDefaultTimeout
} from "bun:test";
import { z } from "zod";
import { resources } from "@/app/infra";
import { authenticate } from "@/app/src/middleware";

// The build runs the CLI's analysis process; allow for slow machines.
setDefaultTimeout(60_000);

/** This example's directory. */
const example = join(import.meta.dir, "..");

/** The built `holqa` binary, through the CLI package's public files. */
const bin = join(dirname(Bun.resolveSync("@holqa/cli/package.json", example)), "dist", "bin.js");

/** Where the build output goes; removed after the run. */
const buildDir = mkdtempSync(join(tmpdir(), "holqa-http-api-"));

/** Log entries the runtime wrote. */
const logs: LogEntry[] = [];

/** The server under test. */
let server: RunningServer;

/** The signed-in demo user's authorization header. */
const signedIn = { authorization: "Bearer token-ada" };

beforeAll(async () => {
  const build = Bun.spawnSync(["bun", bin, "build", "--manifest", "--app", "app/infra.ts", "--out-dir", buildDir], { cwd: example });
  if (build.exitCode !== 0)
    throw new Error(`holqa build failed: ${build.stderr.toString()}`);
  const compiled = await loadCompiledApplication({ root: join(example, "app"), buildDir });
  const runtime = createRuntime({ ...compiled, env: { SHOP_CURRENCY: "USD" }, log: entry => logs.push(entry), limits: { concurrency: 8 } });
  server = await serve(runtime, { port: 0 });
});

afterAll(async () => {
  await server.stop({ graceMs: 1_000 });
  rmSync(buildDir, { recursive: true, force: true });
});

/**
 * Sends a request to the server under test.
 *
 * @param path - The path and query.
 * @param init - Request settings.
 * @returns The response.
 */
async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, server.url), init);
}

/**
 * Sends a JSON request to the server under test.
 *
 * @param path - Where to send it, relative to the server's address.
 * @param body - The value sent as JSON.
 * @param headers - Extra request headers.
 * @returns The response.
 */
async function post(path: string, body: unknown, headers: Readonly<Record<string, string>> = {}): Promise<Response> {
  return call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("a compiled application served by Bun", () => {
  it("executes routes with validated input and typed responses", async () => {
    const placed = await post("/api/orders", { sku: "tea", quantity: 2 }, signedIn);
    expect(placed.status).toBe(201);
    const order = await placed.json() as { readonly orderId: string };
    expect<unknown>(order).toEqual({ orderId: expect.stringMatching(/^ord_\d+$/), sku: "tea", quantity: 2, placedBy: "u1", status: "placed" });
    expect(placed.headers.get("location")).toBe(`/api/orders/${order.orderId}`);
    expect(placed.headers.get("server-timing")).toStartWith("app;dur=");

    const read = await call(`/api/orders/${order.orderId}`);
    expect([read.status, await read.json()]).toEqual([200, order]);
    const missing = await call("/api/orders/ord_999");
    expect([missing.status, await missing.json()]).toEqual([404, { message: "Order ord_999 does not exist." }]);
    const listed = await call("/api/orders?status=placed&limit=5");
    expect((await listed.json() as unknown[]).length).toBeGreaterThan(0);
  });

  it("answers invalid input with a predictable validation response", async () => {
    const invalid = await post("/api/orders", { sku: "", quantity: 1.5 }, signedIn);
    expect(invalid.status).toBe(400);
    const { error } = await invalid.json() as { readonly error: { readonly code: string; readonly invocationId: string; readonly issues: ReadonlyArray<{ readonly path: string }> } };
    expect(error.code).toBe("HOLQA_INPUT_INVALID");
    expect(error.issues.map(issue => issue.path).sort()).toEqual(["quantity", "sku"]);
    expect(error.invocationId).toBe(invalid.headers.get("x-correlation-id")!);

    expect((await call("/api/orders/not-an-id")).status).toBe(400);
    expect((await call("/api/orders?limit=500")).status).toBe(400);
    const notJson = await call("/api/orders", { method: "POST", headers: { ...signedIn, "content-type": "text/plain" }, body: "tea" });
    expect([notJson.status, ((await notJson.json()) as { readonly error: { readonly code: string } }).error.code]).toEqual([415, "HOLQA_HTTP_MEDIA_TYPE_UNSUPPORTED"]);
  });

  it("distinguishes missing routes, method mismatches and rejected requests", async () => {
    expect((await call("/api/customers")).status).toBe(404);
    const wrongMethod = await call("/api/orders", { method: "DELETE" });
    expect([wrongMethod.status, wrongMethod.headers.get("allow")]).toEqual([405, "GET, HEAD, POST"]);
    const anonymous = await post("/api/orders", { sku: "tea", quantity: 1 });
    expect([anonymous.status, anonymous.headers.get("www-authenticate")]).toEqual([401, "Bearer"]);
    expect(((await anonymous.json()) as { readonly error: { readonly code: string } }).error.code).toBe("HOLQA_HTTP_REJECTED");
  });

  it("keeps the state of concurrent invocations independent", async () => {
    const tags = Array.from({ length: 12 }, (_, index) => `t${index}`);
    const responses = await Promise.all(tags.map(async (tag, index) => call(`/api/echo/${tag}?delayMs=${(tags.length - index) * 3}`, { headers: { "x-correlation-id": `req-${tag}` } })));
    const bodies = await Promise.all(responses.map(async response => response.json()));
    expect(bodies).toEqual(tags.map(tag => ({ tag, requestId: `req-${tag}` })));
  });

  it("streams responses", async () => {
    const response = await call("/api/events");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: placed\n\ndata: paid\n\ndata: shipped\n\n");
  });

  it("serves RPC queries and mutations through the same runtime, middleware and validation", async () => {
    const placed = await (await post("/api/orders", { sku: "cake", quantity: 1 }, signedIn)).json() as { readonly orderId: string };
    const count = await call("/api/rpc/orders.count");
    expect(await count.json()).toEqual({ format: "holqa.rpc/1", ok: true, output: { total: expect.any(Number), currency: "USD" } });

    const cancelled = await post("/api/rpc/orders.cancel", { input: { orderId: placed.orderId } }, signedIn);
    expect(await cancelled.json()).toEqual({ format: "holqa.rpc/1", ok: true, output: { orderId: placed.orderId, sku: "cake", quantity: 1, placedBy: "u1", status: "cancelled" } });

    const invalid = await post("/api/rpc/orders.cancel", { input: { orderId: 42 } }, signedIn);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ format: "holqa.rpc/1", ok: false, error: { code: "HOLQA_INPUT_INVALID", issues: [{ path: "orderId" }] } });
    const anonymous = await post("/api/rpc/orders.cancel", { input: { orderId: placed.orderId } });
    expect([anonymous.status, ((await anonymous.json()) as { readonly ok: boolean }).ok]).toEqual([401, false]);
    expect((await call("/api/rpc/orders.cancel")).status).toBe(405);
    const unsupported = await post("/api/rpc/orders.count", {}, { "holqa-rpc-version": "2" });
    expect(((await unsupported.json()) as { readonly error: { readonly code: string } }).error.code).toBe("HOLQA_RPC_VERSION_UNSUPPORTED");
  });

  it("writes structured logs with invocation and correlation identifiers", async () => {
    await call("/api/orders", { headers: { "x-correlation-id": "trace-logs" } });
    const entry = logs.find(({ correlationId, message }) => correlationId === "trace-logs" && message === "invocation completed");
    expect(entry).toMatchObject({ level: "info", application: "shop", handlerId: "orders.list", method: "GET", path: "/api/orders", outcome: "ok" });
    const { invocationId } = entry!;
    expect(typeof invocationId).toBe("string");
  });
});

describe("type contracts", () => {
  it("types middleware context and client contracts from the declarations", () => {
    expectTypeOf<InferRouteContract<typeof placeOrder>["body"]>().toEqualTypeOf<{ sku: string; quantity: number }>();
    expectTypeOf<InferProcedureContract<typeof cancelOrder>["input"]>().toEqualTypeOf<{ orderId: string }>();
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      resources.api.route({
        id: "whoami",
        method: "GET",
        path: "/whoami",
        responses: { 200: z.string() },
        // @ts-expect-error -- without the authenticate middleware there is no user in the context.
        handler: ({ context, reply }) => reply(200, context.user.name)
      });
      resources.api.route({
        id: "whoami-authenticated",
        method: "GET",
        path: "/whoami",
        middleware: [authenticate],
        responses: { 200: z.string() },
        handler: ({ context, reply }) => reply(200, `${context.user.name} (${context.requestId})`)
      });
    };
    expect(typeof neverCalled).toBe("function");
  });
});