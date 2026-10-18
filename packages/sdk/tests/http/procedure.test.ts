import type { InferProcedureContract } from "@/index";

import { getHandlerDescriptor } from "@holqa/core";
import {
  invokeHttp,
  jsonRequest,
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

import {
  http,
  middleware
} from "@/index";

/** An API every test registers procedures on. */
const api = owned(http.api({ id: "rpc-api", basePath: "/api" }));

/** A query with input and output schemas. */
const getOrder = api.procedure({
  id: "orders.get",
  operation: "query",
  input: z.object({ orderId: z.string().min(1) }),
  output: z.object({ orderId: z.string(), placedAt: z.iso.datetime() }),
  handler: ({ input }) => ({ orderId: input.orderId, placedAt: "2026-01-01T00:00:00Z" })
});

describe("procedure registration", () => {
  it("records the operation and schemas", () => {
    const descriptor = getHandlerDescriptor(getOrder);
    expect<unknown>(descriptor?.definition).toEqual({ id: "orders.get", trigger: { kind: "http.procedure", resource: { kind: "http.api", id: "rpc-api" }, options: { operation: "query" } } });
    expect(Object.keys(descriptor?.schemas ?? {})).toEqual(["input", "output"]);
    expect(getOrder).toMatchObject({ trigger: "http.procedure", id: "orders.get", resourceId: "rpc-api" });
  });

  it("types input, output and the client contract", () => {
    type Contract = InferProcedureContract<typeof getOrder>;
    expectTypeOf<Contract>().toEqualTypeOf<{ readonly operation: "query"; readonly input: { orderId: string }; readonly output: { orderId: string; placedAt: string } }>();
    const _ping = api.procedure({
      id: "ping",
      operation: "mutation",
      output: z.string(),
      handler: ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<undefined>();
        return "pong";
      }
    });
    expectTypeOf<InferProcedureContract<typeof _ping>["input"]>().toEqualTypeOf<undefined>();
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      api.procedure({
        id: "wrong",
        operation: "query",
        output: z.object({ total: z.number() }),
        // @ts-expect-error -- the output must match the output schema.
        handler: () => ({ total: "1" })
      });
      api.procedure({
        id: "no-input",
        operation: "query",
        output: z.string(),
        // @ts-expect-error -- without an input schema, input is undefined.
        handler: ({ input }) => input.orderId
      });
      api.procedure({
        id: "needs-user",
        operation: "query",
        // @ts-expect-error -- nothing provides the tenant this middleware requires.
        middleware: [middleware.requires<{ readonly tenant: string }>()({ name: "upper", handle: ({ next }) => next() })],
        output: z.string(),
        handler: () => "x"
      });
      api.procedure({
        id: "no-context",
        operation: "query",
        output: z.string(),
        handler: ({ context }) => {
          expectTypeOf(context).toEqualTypeOf<Readonly<{}>>();
          return "x";
        }
      });
      api.procedure({
        id: "unknown-operation",
        // @ts-expect-error -- only queries and mutations exist.
        operation: "subscription",
        output: z.string(),
        handler: () => "x"
      });
    };
    expect(typeof neverCalled).toBe("function");
  });

  it.each([
    ["an invalid id", { id: "Orders" }, ["HOLQA_RESOURCE_ID_INVALID"]],
    ["an unknown operation", { operation: "subscription" }, ["HOLQA_DECLARATION_INVALID"]],
    ["a missing output", { output: undefined }, ["HOLQA_DECLARATION_INVALID"]],
    ["a non-schema input", { input: {} }, ["HOLQA_DECLARATION_INVALID"]],
    ["a missing handler", { handler: 1 }, ["HOLQA_DECLARATION_INVALID"]]
  ])("rejects %s when declared", (_label, override, codes) => {
    const valid = { id: "orders.list", operation: "query", output: z.string(), handler: () => "x" };
    expect(thrownCodes(() => api.procedure({ ...valid, ...override } as never))).toEqual(codes);
  });
});

describe("procedure invocation", () => {
  it("answers a POST call with a success envelope", async () => {
    const response = await invokeHttp(getOrder, jsonRequest("http://localhost/api/rpc/orders.get", { input: { orderId: "o1" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ format: "holqa.rpc/1", ok: true, output: { orderId: "o1", placedAt: "2026-01-01T00:00:00Z" } });
  });

  it("reads the input of a GET query from the input parameter", async () => {
    const input = encodeURIComponent(JSON.stringify({ orderId: "o2" }));
    const response = await invokeHttp(getOrder, new Request(`http://localhost/api/rpc/orders.get?input=${input}`, { headers: { "holqa-rpc-version": "1" } }));
    expect(await response.json()).toMatchObject({ ok: true, output: { orderId: "o2" } });
  });

  it("omits the output of a procedure that returns nothing, and accepts an empty body without input", async () => {
    const fire = api.procedure({ id: "fire", operation: "mutation", output: z.undefined(), handler: () => undefined });
    const response = await invokeHttp(fire, new Request("http://localhost/api/rpc/fire", { method: "POST" }));
    expect(await response.json()).toEqual({ format: "holqa.rpc/1", ok: true });
  });

  it.each([
    ["invalid input", jsonRequest("http://localhost/api/rpc/orders.get", { input: { orderId: "" } }), "HOLQA_INPUT_INVALID"],
    ["missing input", new Request("http://localhost/api/rpc/orders.get", { method: "POST" }), "HOLQA_INPUT_INVALID"],
    ["an envelope with unknown keys", jsonRequest("http://localhost/api/rpc/orders.get", { orderId: "o1" }), "HOLQA_PAYLOAD_MALFORMED"],
    ["a non-object envelope", jsonRequest("http://localhost/api/rpc/orders.get", ["o1"]), "HOLQA_PAYLOAD_MALFORMED"],
    ["malformed GET input", new Request("http://localhost/api/rpc/orders.get?input=%7B"), "HOLQA_PAYLOAD_MALFORMED"],
    ["repeated GET input", new Request("http://localhost/api/rpc/orders.get?input=1&input=2"), "HOLQA_PAYLOAD_MALFORMED"],
    ["a non-JSON body", new Request("http://localhost/api/rpc/orders.get", { method: "POST", body: "orderId=o1" }), "HOLQA_HTTP_MEDIA_TYPE_UNSUPPORTED"],
    ["an unsupported protocol version", new Request("http://localhost/api/rpc/orders.get", { method: "POST", headers: { "holqa-rpc-version": "2" } }), "HOLQA_RPC_VERSION_UNSUPPORTED"]
  ])("rejects %s", async (_label, request, code) => {
    expect(await rejectedCodes(() => invokeHttp(getOrder, request))).toEqual([code]);
  });

  it("rejects input sent to a procedure without input", async () => {
    const ping = api.procedure({ id: "ping-input", operation: "query", output: z.string(), handler: () => "pong" });
    expect(await rejectedCodes(() => invokeHttp(ping, jsonRequest("http://localhost/api/rpc/ping-input", { input: 1 })))).toEqual(["HOLQA_INPUT_INVALID"]);
  });

  it("rejects output that breaks the output schema", async () => {
    const broken = api.procedure({ id: "broken", operation: "query", output: z.number().int(), handler: () => 1.5 });
    expect(await rejectedCodes(() => invokeHttp(broken, new Request("http://localhost/api/rpc/broken")))).toEqual(["HOLQA_RESPONSE_INVALID"]);
  });

  it("runs API and procedure middleware with typed context", async () => {
    const tenant = middleware({ name: "tenant", handle: ({ request, next }) => next({ tenant: request.headers.get("x-tenant") ?? "none" }) });
    const tenantApi = owned(http.api({ id: "tenant-api", basePath: "/", middleware: [tenant] }));
    const whoami = tenantApi.procedure({
      id: "whoami",
      operation: "query",
      middleware: [middleware.requires<{ readonly tenant: string }>()({ name: "upper", handle: ({ context, next }) => next({ tenant: context.tenant.toUpperCase() }) })],
      output: z.string(),
      handler: ({ context }) => {
        expectTypeOf(context.tenant).toEqualTypeOf<string>();
        return context.tenant;
      }
    });
    const response = await invokeHttp(whoami, new Request("http://localhost/rpc/whoami", { headers: { "x-tenant": "acme" } }));
    expect(await response.json()).toMatchObject({ output: "ACME" });
  });
});