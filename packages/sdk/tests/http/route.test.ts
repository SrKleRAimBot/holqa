import type {
  InferRouteContract,
  QueryRecord
} from "@/index";

import {
  getHandlerDescriptor,
  isHolqaError,
  isHttpRejectedError,
  validateInput
} from "@holqa/core";
import {
  invokeHttp,
  owned,
  rejectedCodes
} from "@test/support/http";
import { thrownCodes } from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";
import { z } from "zod";

import { http } from "@/index";

/** An API every test registers routes on. */
const api = owned(http.api({ id: "shop-api", basePath: "/api" }));

/** The response contract of an order. */
const order = z.object({ orderId: z.string(), total: z.number().int().nonnegative() });

/** The error body of a missing order. */
const notFound = z.object({ message: z.string() });

describe("route registration", () => {
  it("records JSON metadata and schemas by role, separately from invoke", () => {
    const params = z.object({ orderId: z.string() });
    const route = api.route({
      id: "orders.get",
      method: "GET",
      path: "/orders/:orderId",
      params,
      responses: { 200: order, 404: notFound },
      handler: ({ params: { orderId }, reply }) => reply(200, { orderId, total: 1 })
    });
    const descriptor = getHandlerDescriptor(route);
    expect<unknown>(descriptor?.definition).toEqual({
      id: "orders.get",
      trigger: { kind: "http.route", resource: { kind: "http.api", id: "shop-api" }, options: { method: "GET", path: "/orders/:orderId" } }
    });
    expect<unknown>(descriptor?.schemas).toEqual({ params, responses: { 200: order, 404: notFound } });
    expect(route).toMatchObject({ trigger: "http.route", id: "orders.get", resourceId: "shop-api" });
  });

  it("infers path parameters, query, headers and body from the declaration", () => {
    api.route({
      id: "stores.orders.list",
      method: "GET",
      path: "/stores/:storeId/orders/:status",
      query: z.object({ page: z.coerce.number().int().positive().default(1) }),
      headers: z.object({ "x-tenant": z.string() }),
      responses: { 200: z.array(order) },
      handler: ({ params, query, headers, body, reply }) => {
        expectTypeOf(params).toEqualTypeOf<{ readonly storeId: string; readonly status: string }>();
        expectTypeOf(query).toEqualTypeOf<{ page: number }>();
        expectTypeOf(headers).toEqualTypeOf<{ "x-tenant": string }>();
        expectTypeOf(body).toEqualTypeOf<undefined>();
        return reply(200, []);
      }
    });
    api.route({
      id: "orders.raw",
      method: "POST",
      path: "/raw",
      body: order,
      responses: { 204: z.undefined() },
      handler: ({ query, headers, body, reply }) => {
        expectTypeOf(query).toEqualTypeOf<QueryRecord>();
        expectTypeOf(headers).toEqualTypeOf<Readonly<Record<string, string>>>();
        expectTypeOf(body).toEqualTypeOf<{ orderId: string; total: number }>();
        return reply(204, undefined);
      }
    });
  });

  it("rejects mismatched params schemas, bodies on GET, undeclared statuses and wrong bodies at compile time", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      api.route({
        id: "a",
        method: "GET",
        path: "/orders/:orderId",
        // @ts-expect-error -- the schema must declare exactly the template's parameters.
        params: z.object({ id: z.string() }),
        responses: { 200: order },
        handler: ({ reply }) => reply(200, { orderId: "1", total: 1 })
      });
      api.route({
        id: "b",
        method: "GET",
        path: "/orders",
        // @ts-expect-error -- GET routes have no body.
        body: order,
        responses: { 200: order },
        handler: ({ reply }) => reply(200, { orderId: "1", total: 1 })
      });
      api.route({
        id: "c",
        method: "GET",
        path: "/orders",
        responses: { 200: order, 404: notFound },
        // @ts-expect-error -- 500 is not a declared status.
        handler: ({ reply }) => reply(500, { message: "no" })
      });
      api.route({
        id: "e",
        method: "GET",
        path: "/orders",
        responses: { 200: order, 404: notFound },
        // @ts-expect-error -- a status union cannot pair with the body of only one of its statuses.
        handler: ({ reply }) => reply(Math.random() > 0.5 ? 200 : 404, { message: "no" })
      });
      api.route({
        id: "f",
        method: "GET",
        path: "/orders/:orderId",
        // @ts-expect-error -- path parameters arrive as strings; a number schema would reject every request.
        params: z.object({ orderId: z.number() }),
        responses: { 200: order },
        handler: ({ reply }) => reply(200, { orderId: "1", total: 1 })
      });
      api.route({
        id: "g",
        method: "DELETE",
        path: "/orders",
        // @ts-expect-error -- DELETE routes have no body.
        body: order,
        responses: { 204: z.undefined() },
        handler: ({ reply }) => reply(204, undefined)
      });
      api.route({
        id: "h",
        method: Math.random() > 0.5 ? "GET" : "POST",
        path: "/orders",
        // @ts-expect-error -- a method union that includes GET has no body.
        body: order,
        responses: { 200: order },
        handler: ({ reply }) => reply(200, { orderId: "1", total: 1 })
      });
      api.route({
        id: "d",
        method: "GET",
        path: "/orders",
        responses: { 200: order, 404: notFound },
        // @ts-expect-error -- the 404 body has the wrong shape.
        handler: ({ reply }) => reply(404, { orderId: "1", total: 1 })
      });
      // @ts-expect-error -- route identifiers follow the resource identifier grammar.
      api.route({
        id: "Orders",
        method: "GET",
        path: "/orders",
        responses: { 200: order },
        handler: ({ reply }) => reply(200, { orderId: "1", total: 1 })
      });
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("exposes a client contract with input types for requests and output types for responses", () => {
    const _route = api.route({
      id: "orders.create",
      method: "POST",
      path: "/stores/:storeId/orders",
      body: z.object({ total: z.string().transform(Number) }),
      responses: { 201: order, 404: notFound },
      handler: ({ reply }) => reply(201, { orderId: "1", total: 1 })
    });
    type Contract = InferRouteContract<typeof _route>;
    expectTypeOf<Contract["method"]>().toEqualTypeOf<"POST">();
    expectTypeOf<Contract["params"]>().toEqualTypeOf<{ readonly storeId: string }>();
    expectTypeOf<Contract["body"]>().toEqualTypeOf<{ total: string }>();
    expectTypeOf<Contract["response"]>().toEqualTypeOf<{ readonly status: 201; readonly body: { orderId: string; total: number } } | { readonly status: 404; readonly body: { message: string } }>();
  });

  it.each([
    ["an invalid id", { id: "Orders" }, ["HOLQA_RESOURCE_ID_INVALID"]],
    ["an unknown method", { method: "TRACE" }, ["HOLQA_DECLARATION_INVALID"]],
    ["a trailing slash", { path: "/orders/" }, ["HOLQA_DECLARATION_INVALID"]],
    ["a repeated parameter", { path: "/a/:id/b/:id" }, ["HOLQA_DECLARATION_INVALID"]],
    ["a GET body", { body: order }, ["HOLQA_DECLARATION_INVALID"]],
    ["no responses", { responses: {} }, ["HOLQA_DECLARATION_INVALID"]],
    ["an invalid status", { responses: { 99: order } }, ["HOLQA_DECLARATION_INVALID"]],
    ["a non-schema response", { responses: { 200: "order" } }, ["HOLQA_DECLARATION_INVALID"]],
    ["a non-schema query", { query: {} }, ["HOLQA_DECLARATION_INVALID"]],
    ["non-middleware", { middleware: [() => undefined] }, ["HOLQA_DECLARATION_INVALID"]],
    ["a missing handler", { handler: undefined }, ["HOLQA_DECLARATION_INVALID"]]
  ])("rejects %s when declared", (_label, override, codes) => {
    const valid = { id: "orders.list", method: "GET", path: "/orders", responses: { 200: order }, handler: () => new Response() };
    expect(thrownCodes(() => api.route({ ...valid, ...override } as never))).toEqual(codes);
  });
});

describe("route invocation", () => {
  /** A route exercising every request part. */
  const create = api.route({
    id: "orders.create",
    method: "POST",
    path: "/stores/:storeId/orders",
    params: z.object({ storeId: z.string().regex(/^s\d+$/) }),
    query: z.object({ dryRun: z.enum(["true", "false"]).optional() }),
    headers: z.object({ "x-tenant": z.string().min(1) }),
    body: z.object({ total: z.number().int().nonnegative() }),
    responses: { 201: order, 409: notFound },
    handler: ({ params, query, headers, body, reply }) => query.dryRun === "true"
      ? reply(409, { message: `dry run for ${headers["x-tenant"]}` })
      : reply(201, { orderId: `${params.storeId}-1`, total: body.total }, { location: "/api/orders/1" })
  });

  /**
   * Builds a request to the create route.
   *
   * @param body - The JSON body.
   * @param query - The query string.
   * @param tenant - The tenant header, or `null` to omit it.
   * @returns A POST request with a JSON body.
   */
  const createRequest = (body: unknown, query = "", tenant: string | null = "acme"): Request => new Request(`http://localhost/api/stores/s1/orders${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...tenant === null ? {} : { "x-tenant": tenant } },
    body: JSON.stringify(body)
  });

  it("validates every part, runs the handler and encodes the declared response", async () => {
    const response = await invokeHttp(create, createRequest({ total: 42 }), { params: { storeId: "s1" } });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("location")).toBe("/api/orders/1");
    expect(await response.json()).toEqual({ orderId: "s1-1", total: 42 });

    const conflict = await invokeHttp(create, createRequest({ total: 1 }, "?dryRun=true"), { params: { storeId: "s1" } });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ message: "dry run for acme" });
  });

  it.each([
    ["path parameters", createRequest({ total: 1 }), { storeId: "x" }, "HOLQA_INPUT_INVALID"],
    ["the query", createRequest({ total: 1 }, "?dryRun=maybe"), { storeId: "s1" }, "HOLQA_INPUT_INVALID"],
    ["headers", createRequest({ total: 1 }, "", null), { storeId: "s1" }, "HOLQA_INPUT_INVALID"],
    ["the body", createRequest({ total: -1 }), { storeId: "s1" }, "HOLQA_INPUT_INVALID"],
    ["a missing body", new Request("http://localhost/api/stores/s1/orders", { method: "POST", headers: { "x-tenant": "acme" } }), { storeId: "s1" }, "HOLQA_INPUT_INVALID"],
    ["malformed JSON", new Request("http://localhost/api/stores/s1/orders", { method: "POST", headers: { "content-type": "application/json", "x-tenant": "acme" }, body: "{" }), { storeId: "s1" }, "HOLQA_PAYLOAD_MALFORMED"],
    ["a non-JSON body", new Request("http://localhost/api/stores/s1/orders", { method: "POST", headers: { "content-type": "text/plain", "x-tenant": "acme" }, body: "total=1" }), { storeId: "s1" }, "HOLQA_HTTP_MEDIA_TYPE_UNSUPPORTED"]
  ])("rejects invalid %s before the handler runs", async (_label, request, params, code) => {
    expect(await rejectedCodes(() => invokeHttp(create, request, { params }))).toEqual([code]);
  });

  it("reports validation issues by field", async () => {
    try {
      await invokeHttp(create, createRequest({ total: "many" }), { params: { storeId: "s1" } });
      throw new Error("Expected a rejection.");
    } catch (error) {
      expect((error as { readonly issues?: ReadonlyArray<{ readonly path: string }> }).issues?.map(issue => issue.path)).toEqual(["total"]);
    }
  });

  it("marks request problems as the caller's fault, with 400 or 415, but never the handler's own Holqa errors", async () => {
    /**
     * Captures the rejection of an invocation.
     *
     * @param request - The request to send.
     * @returns What the invocation rejected with, or `undefined` when it succeeded.
     */
    const rejection = async (request: Request): Promise<unknown> => invokeHttp(create, request, { params: { storeId: "s1" } }).then(() => undefined, (error: unknown) => error);
    const invalid = await rejection(createRequest({ total: -1 }));
    expect(isHttpRejectedError(invalid) && invalid.status).toBe(400);
    const unsupported = await rejection(new Request("http://localhost/api/stores/s1/orders", { method: "POST", headers: { "content-type": "text/plain", "x-tenant": "acme" }, body: "x" }));
    expect(isHttpRejectedError(unsupported) && unsupported.status).toBe(415);

    const internal = api.route({ id: "internal", method: "GET", path: "/internal", responses: { 200: z.string() }, handler: async ({ reply }) => reply(200, await validateInput(z.string(), 42, "an internal value")) });
    const error = await invokeHttp(internal, new Request("http://localhost/api/internal")).then(() => undefined, (failure: unknown) => failure);
    expect(isHolqaError(error) && error.code).toBe("HOLQA_INPUT_INVALID");
    expect(isHttpRejectedError(error)).toBe(false);
  });

  it("rejects responses that break the contract", async () => {
    const undeclared = api.route({ id: "a.undeclared", method: "GET", path: "/a", responses: { 200: order }, handler: ({ reply }) => (reply as (status: number, body: unknown) => never)(500, {}) });
    const wrongBody = api.route({ id: "a.wrong", method: "GET", path: "/b", responses: { 200: order }, handler: ({ reply }) => reply(200, { orderId: "1", total: -5 }) });
    const notJson = api.route({ id: "a.date", method: "GET", path: "/c", responses: { 200: z.unknown() }, handler: ({ reply }) => reply(200, new Date(0)) });
    const neither = api.route({ id: "a.neither", method: "GET", path: "/d", responses: { 200: order }, handler: () => ({ status: 200, body: {} }) as never });
    const rawUndeclared = api.route({ id: "a.raw", method: "GET", path: "/e", responses: { 200: order }, handler: () => new Response(null, { status: 418 }) });
    const bodyOn204 = api.route({ id: "a.empty", method: "DELETE", path: "/f", responses: { 204: z.unknown() }, handler: ({ reply }) => reply(204, { gone: true }) });
    for (const route of [undeclared, wrongBody, notJson, neither, rawUndeclared, bodyOn204])
      expect(await rejectedCodes(() => invokeHttp(route, new Request("http://localhost/")))).toEqual(["HOLQA_RESPONSE_INVALID"]);
  });

  it("passes a declared Response through without reading its body, for streaming", async () => {
    const encoder = new TextEncoder();
    const stream = api.route({
      id: "events.stream",
      method: "GET",
      path: "/events",
      responses: { 200: z.string() },
      handler: () => new Response(new ReadableStream({
        start: (controller) => {
          controller.enqueue(encoder.encode("data: 1\n\n"));
          controller.enqueue(encoder.encode("data: 2\n\n"));
          controller.close();
        }
      }), { headers: { "content-type": "text/event-stream" } })
    });
    const response = await invokeHttp(stream, new Request("http://localhost/api/events"));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: 1\n\ndata: 2\n\n");
  });

  it("leaves the request body unread when no body schema is declared", async () => {
    const upload = api.route({
      id: "uploads.create",
      method: "PUT",
      path: "/uploads",
      responses: { 200: z.object({ bytes: z.number() }) },
      handler: async ({ request, body, reply }) => reply(200, { bytes: body === undefined ? (await request.arrayBuffer()).byteLength : -1 })
    });
    const response = await invokeHttp(upload, new Request("http://localhost/api/uploads", { method: "PUT", body: new Uint8Array(5) }));
    expect(await response.json()).toEqual({ bytes: 5 });
  });

  it("gives the handler raw parameters, repeated query values and lowercase headers without schemas", async () => {
    const echo = api.route({
      id: "echo",
      method: "GET",
      path: "/echo/:name",
      responses: { 200: z.unknown() },
      handler: ({ params, query, headers, reply }) => reply(200, { params, query, tenant: headers["x-tenant"] })
    });
    const response = await invokeHttp(echo, new Request("http://localhost/api/echo/a%20b?tag=x&tag=y&page=2&__proto__=z", { headers: { "X-Tenant": "acme" } }), { params: { name: "a b" } });
    expect(await response.json()).toEqual({ params: { name: "a b" }, query: { tag: ["x", "y"], page: "2", ["__proto__"]: "z" }, tenant: "acme" });
  });

  it("refuses to serve a route whose API belongs to no application, so application middleware is never skipped", async () => {
    const orphan = http.api({ id: "orphan-api", basePath: "/" }).route({ id: "orphan", method: "GET", path: "/", responses: { 200: z.string() }, handler: ({ reply }) => reply(200, "ok") });
    expect(await rejectedCodes(() => invokeHttp(orphan, new Request("http://localhost/")))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });

  it("rejects an invocation without an HTTP request", async () => {
    const descriptor = getHandlerDescriptor(create)!;
    /** Discards a log entry. */
    const silent = (): void => {};
    expect(await rejectedCodes(() => descriptor.invoke({ body: {} }, { invocationId: "x", signal: new AbortController().signal, metadata: {}, log: { info: silent, warn: silent, error: silent } } as never))).toEqual(["HOLQA_INPUT_INVALID"]);
  });
});