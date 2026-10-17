import {
  errorCode,
  getHandlerDescriptor
} from "@holqa/experiment-model";
import { createContext } from "@test/support/fake-binding";

import {
  describe,
  expect,
  it
} from "bun:test";

import { z } from "zod";
import { http } from "@/index";

describe("http routes", () => {
  const api = http.api({ id: "api", basePath: "/api", docs: { title: "Demo", version: "1.0.0" } });
  const route = api.route({
    id: "items.get",
    method: "GET",
    path: "/items/:itemId",
    params: z.object({ itemId: z.coerce.number().int() }),
    query: z.object({ verbose: z.enum(["yes", "no"]).optional() }),
    responses: { 200: z.object({ id: z.number(), verbose: z.boolean() }), 404: z.object({ message: z.string() }) },
    handler: ({ params, query, reply }) => params.itemId === 0
      ? reply(404, { message: "missing" })
      : reply(200, { id: params.itemId, verbose: query.verbose === "yes" })
  });
  const descriptor = getHandlerDescriptor(route)!;

  it("describes the route trigger and every schema by role", () => {
    expect(descriptor.trigger).toEqual({ kind: "http.route", resource: "api", method: "GET", path: "/items/:itemId" });
    expect(Object.keys(descriptor.schemas).sort()).toEqual(["params", "query", "response.200", "response.404"]);
    expect(api["~holqa"].config).toEqual({ basePath: "/api", docs: { title: "Demo", version: "1.0.0" } });
  });

  it("validates and decodes path parameters and query before the handler runs", async () => {
    expect(await descriptor.invoke({ params: { itemId: "7" }, query: { verbose: "yes" } }, createContext())).toEqual({ status: 200, body: { id: 7, verbose: true }, headers: {} });
    expect(await descriptor.invoke({ params: { itemId: "0" } }, createContext())).toEqual({ status: 404, body: { message: "missing" }, headers: {} });
    expect(await descriptor.invoke({ params: { itemId: "x" } }, createContext()).then(() => undefined, (error: unknown) => errorCode(error))).toBe("HOLQA_INPUT_INVALID");
    expect(await descriptor.invoke({ params: { itemId: "1" }, query: { verbose: 1 } }, createContext()).then(() => undefined, (error: unknown) => errorCode(error))).toBe("HOLQA_INPUT_INVALID");
  });

  it("rejects responses with undeclared statuses at runtime", async () => {
    const loose = getHandlerDescriptor(api.route({ id: "loose", method: "GET", path: "/loose", responses: { 200: z.null() }, handler: () => ({ status: 500, body: null }) as never }))!;
    expect(await loose.invoke({}, createContext()).then(() => undefined, (error: unknown) => errorCode(error))).toBe("HOLQA_DECLARATION_INVALID");
  });
});