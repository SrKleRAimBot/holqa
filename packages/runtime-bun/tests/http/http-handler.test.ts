import type { RuntimeOptions } from "@/index";

import { HttpRejectedError } from "@holqa/core";
import {
  apiResource,
  application,
  procedureHandler,
  routeHandler,
  sequentialIds
} from "@test/support/descriptors";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import {
  createRuntime,
  silentSink
} from "@/index";

/** Runtimes started by a test, stopped after it. */
const started: Array<ReturnType<typeof createRuntime>> = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map(async runtime => runtime.stop({ graceMs: 10, forceMs: 10 })));
});

/**
 * Starts a runtime serving one API at `/api` with the given handlers.
 *
 * @param handlers - The handler registrations.
 * @param options - Extra runtime settings.
 * @returns The started runtime.
 */
async function serveHandlers(handlers: readonly unknown[], options: Partial<RuntimeOptions> = {}): Promise<ReturnType<typeof createRuntime>> {
  const runtime = createRuntime({ app: application([apiResource("api")]), handlers, env: {}, log: silentSink, createId: sequentialIds(), ...options });
  await runtime.start();
  started.push(runtime);
  return runtime;
}

/**
 * Reads a JSON response body.
 *
 * @param response - A runtime response with a JSON body.
 * @returns The parsed body.
 */
async function body(response: Response): Promise<unknown> {
  return response.json();
}

describe("routing", () => {
  it("passes the request and decoded path parameters to the matched route", async () => {
    const runtime = await serveHandlers([routeHandler("orders.get", "api", "GET", "/orders/:orderId", ({ request, params }) => Response.json({ params, method: request.method }))]);
    const response = await runtime.fetch(new Request("http://localhost/api/orders/a%20b"));
    expect(await body(response)).toEqual({ params: { orderId: "a b" }, method: "GET" });
    expect(response.headers.get("x-correlation-id")).toBe("inv-1");
  });

  it("prefers static segments over parameters, from left to right", async () => {
    const runtime = await serveHandlers([
      routeHandler("orders.by-id", "api", "GET", "/orders/:id", () => new Response("by-id")),
      routeHandler("orders.new", "api", "GET", "/orders/new", () => new Response("new")),
      routeHandler("a.b", "api", "GET", "/:a/b/:c", () => new Response("param-first")),
      routeHandler("a.c", "api", "GET", "/x/:b/c", () => new Response("static-first"))
    ]);
    expect(await (await runtime.fetch(new Request("http://localhost/api/orders/new"))).text()).toBe("new");
    expect(await (await runtime.fetch(new Request("http://localhost/api/orders/7"))).text()).toBe("by-id");
    expect(await (await runtime.fetch(new Request("http://localhost/api/x/b/c"))).text()).toBe("static-first");
    expect(await (await runtime.fetch(new Request("http://localhost/api/y/b/z"))).text()).toBe("param-first");
  });

  it("distinguishes a missing route, a method mismatch and a malformed path", async () => {
    const runtime = await serveHandlers([routeHandler("orders.get", "api", "GET", "/orders/:id"), routeHandler("orders.delete", "api", "DELETE", "/orders/:id")]);
    const missing = await runtime.fetch(new Request("http://localhost/api/customers"));
    expect([missing.status, await body(missing)]).toEqual([404, { error: { code: "HOLQA_HTTP_ROUTE_NOT_FOUND", message: "No route or procedure serves /api/customers." } }]);
    const wrongMethod = await runtime.fetch(new Request("http://localhost/api/orders/1", { method: "PUT" }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("DELETE, GET, HEAD");
    expect(((await body(wrongMethod)) as { readonly error: { readonly code: string } }).error.code).toBe("HOLQA_HTTP_METHOD_NOT_ALLOWED");
    const malformed = await runtime.fetch(new Request("http://localhost/api/orders/%E0%A4%A"));
    expect([malformed.status, ((await body(malformed)) as { readonly error: { readonly code: string } }).error.code]).toEqual([400, "HOLQA_INPUT_INVALID"]);
  });

  it("answers HEAD with the GET route's status and headers but no body", async () => {
    const runtime = await serveHandlers([routeHandler("orders.list", "api", "GET", "/orders", () => Response.json([1, 2, 3]))]);
    const response = await runtime.fetch(new Request("http://localhost/api/orders", { method: "HEAD" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toBe("");
  });

  it("answers OPTIONS with the allowed methods", async () => {
    const runtime = await serveHandlers([routeHandler("orders.list", "api", "GET", "/orders")]);
    const response = await runtime.fetch(new Request("http://localhost/api/orders", { method: "OPTIONS" }));
    expect([response.status, response.headers.get("allow")]).toEqual([204, "GET, HEAD, OPTIONS"]);
  });
});

describe("error responses", () => {
  it("sends rejections with their status, code, message, issues and headers", async () => {
    const runtime = await serveHandlers([routeHandler("secure", "api", "GET", "/secure", () => {
      throw new HttpRejectedError(401, "Sign in to continue.", { headers: { "www-authenticate": "Bearer" } });
    })]);
    const response = await runtime.fetch(new Request("http://localhost/api/secure"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await body(response)).toEqual({ error: { code: "HOLQA_HTTP_REJECTED", message: "Sign in to continue.", invocationId: "inv-1" } });
  });

  it("hides the details of handler failures and invalid responses behind generic messages", async () => {
    const runtime = await serveHandlers([
      routeHandler("fails", "api", "GET", "/fails", () => {
        throw new TypeError("secret internals");
      }),
      routeHandler("not-a-response", "api", "GET", "/value", () => ({ hello: "world" }) as never)
    ]);
    const failed = await runtime.fetch(new Request("http://localhost/api/fails"));
    expect([failed.status, await body(failed)]).toEqual([500, { error: { code: "HOLQA_HANDLER_FAILED", message: "The handler failed. Details were logged with the invocation identifier.", invocationId: "inv-1" } }]);
    const invalid = await runtime.fetch(new Request("http://localhost/api/value"));
    expect([invalid.status, ((await body(invalid)) as { readonly error: { readonly code: string } }).error.code]).toEqual([500, "HOLQA_RESPONSE_INVALID"]);
  });

  it("answers a generic 500 instead of rejecting when a foreign rejection is malformed", async () => {
    const forged = Object.assign(new Error("forged"), { name: "HttpRejectedError", status: 401, headers: { "bad header": "x" }, issues: [], diagnostics: [{ code: "HOLQA_HTTP_REJECTED", severity: "error", message: "No." }] });
    const runtime = await serveHandlers([routeHandler("forged", "api", "GET", "/forged", () => {
      throw forged;
    })]);
    const response = await runtime.fetch(new Request("http://localhost/api/forged"));
    expect([response.status, ((await body(response)) as { readonly error: { readonly code: string } }).error.code]).toEqual([500, "HOLQA_HANDLER_FAILED"]);
  });

  it("adopts a well-formed correlation identifier from the caller, unless told not to trust it", async () => {
    const handlers = [routeHandler("echo", "api", "GET", "/echo", (_input, context) => new Response(context.correlationId))];
    const trusting = await serveHandlers(handlers);
    const adopted = await trusting.fetch(new Request("http://localhost/api/echo", { headers: { "x-correlation-id": "trace-1" } }));
    expect([await adopted.text(), adopted.headers.get("x-correlation-id")]).toEqual(["trace-1", "trace-1"]);
    const forged = await trusting.fetch(new Request("http://localhost/api/echo", { headers: { "x-correlation-id": "a b {}" } }));
    expect(await forged.text()).toBe("inv-2");
    const distrusting = await serveHandlers(handlers, { http: { trustCorrelationHeader: false } });
    expect(await (await distrusting.fetch(new Request("http://localhost/api/echo", { headers: { "x-correlation-id": "trace-1" } }))).text()).toBe("inv-1");
  });
});

describe("RPC transport", () => {
  it("routes POST to every procedure and GET only to queries", async () => {
    const runtime = await serveHandlers([
      procedureHandler("orders.get", "api", "query", ({ request }) => Response.json({ format: "holqa.rpc/1", ok: true, output: request.method })),
      procedureHandler("orders.cancel", "api", "mutation")
    ]);
    expect(await body(await runtime.fetch(new Request("http://localhost/api/rpc/orders.get")))).toEqual({ format: "holqa.rpc/1", ok: true, output: "GET" });
    expect(await body(await runtime.fetch(new Request("http://localhost/api/rpc/orders.get", { method: "POST" })))).toEqual({ format: "holqa.rpc/1", ok: true, output: "POST" });
    const getMutation = await runtime.fetch(new Request("http://localhost/api/rpc/orders.cancel"));
    expect(getMutation.status).toBe(405);
    expect(getMutation.headers.get("allow")).toBe("POST");
    expect(await body(getMutation)).toEqual({ format: "holqa.rpc/1", ok: false, error: { code: "HOLQA_HTTP_METHOD_NOT_ALLOWED", message: "GET is not allowed for /api/rpc/orders.cancel." } });
  });

  it("encodes failures, including unknown procedures, as failure envelopes", async () => {
    const runtime = await serveHandlers([procedureHandler("orders.get", "api", "query", () => {
      throw new HttpRejectedError(403, "Not your order.");
    })]);
    const rejected = await runtime.fetch(new Request("http://localhost/api/rpc/orders.get", { method: "POST" }));
    expect([rejected.status, await body(rejected)]).toEqual([403, { format: "holqa.rpc/1", ok: false, error: { code: "HOLQA_HTTP_REJECTED", message: "Not your order.", invocationId: "inv-1" } }]);
    const unknown = await runtime.fetch(new Request("http://localhost/api/rpc/orders.missing", { method: "POST" }));
    expect([unknown.status, ((await body(unknown)) as { readonly format: string }).format]).toEqual([404, "holqa.rpc/1"]);
  });
});

describe("CORS", () => {
  it("answers preflights for allowed origins and adds headers to responses", async () => {
    const runtime = await serveHandlers([routeHandler("orders.create", "api", "POST", "/orders", () => new Response("created", { status: 201 }))], {
      http: { cors: { origins: ["https://app.example"], credentials: true, maxAgeSeconds: 600, exposeHeaders: ["location"] } }
    });
    const preflight = await runtime.fetch(new Request("http://localhost/api/orders", {
      method: "OPTIONS",
      headers: { "origin": "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" }
    }));
    expect(preflight.status).toBe(204);
    expect(Object.fromEntries(preflight.headers)).toMatchObject({
      "access-control-allow-origin": "https://app.example",
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
      "access-control-allow-credentials": "true",
      "access-control-max-age": "600"
    });
    const actual = await runtime.fetch(new Request("http://localhost/api/orders", { method: "POST", headers: { origin: "https://app.example" } }));
    expect(Object.fromEntries(actual.headers)).toMatchObject({ "access-control-allow-origin": "https://app.example", "access-control-expose-headers": "x-correlation-id, location", "vary": "origin" });
    const foreign = await runtime.fetch(new Request("http://localhost/api/orders", { method: "OPTIONS", headers: { "origin": "https://evil.example", "access-control-request-method": "POST" } }));
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    expect(foreign.headers.get("vary")).toBe("origin");
    const noOrigin = await runtime.fetch(new Request("http://localhost/api/orders", { method: "POST" }));
    expect(noOrigin.headers.get("vary")).toBe("origin");
  });

  it("adds CORS headers to error responses too, so browsers can read them", async () => {
    const runtime = await serveHandlers([], { http: { cors: { origins: "*" } } });
    const response = await runtime.fetch(new Request("http://localhost/api/missing", { headers: { origin: "https://any.example" } }));
    expect([response.status, response.headers.get("access-control-allow-origin")]).toEqual([404, "*"]);
  });

  it("rejects credentials with every origin", () => {
    expect(() => createRuntime({ app: application([apiResource("api")]), handlers: [], http: { cors: { origins: "*", credentials: true } } })).toThrow("credentials");
  });
});