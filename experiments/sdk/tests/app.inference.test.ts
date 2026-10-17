import type {
  getOrder,
  placeOrder
} from "@test/fixtures/shop/handlers/place-order";
import type { env } from "@test/fixtures/shop/infra";

// Type-inference experiment: exact schema types must flow from infra.ts
// through defineApp, resource handles and separately defined handler modules,
// with no generated types. `tsc --noEmit` (pnpm typecheck) enforces these
// assertions; bun:test only executes the runtime parts.
import type { InferRouteContract } from "@/index";
import processOrder from "@test/fixtures/shop/handlers/process-order";
import { resources } from "@test/fixtures/shop/infra";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";
import { z } from "zod";
import {
  bucket,
  defineApp,
  http,
  queue
} from "@/index";

describe("type inference from infra.ts", () => {
  it("preserves literal resource identifiers and handler identifiers", () => {
    expectTypeOf(resources.orders.id).toEqualTypeOf<"order-placed">();
    expectTypeOf(resources.api.id).toEqualTypeOf<"shop-api">();
    expectTypeOf(processOrder.id).toEqualTypeOf<"orders.process">();
    expectTypeOf(processOrder.queueId).toEqualTypeOf<"order-placed">();
    expect(resources.orders.id).toBe("order-placed");
  });

  it("types send with the schema input and consumers with the schema output", () => {
    type Sent = Parameters<typeof resources.orders.send>[0];
    // Input side: `priority` has a default, so it is optional; `placedAt` is an ISO string.
    expectTypeOf<Sent["priority"]>().toEqualTypeOf<"normal" | "urgent" | undefined>();
    expectTypeOf<Sent["placedAt"]>().toEqualTypeOf<string>();
    // Imported, branded schemas keep their brand on the output side only.
    expectTypeOf<Sent["lines"][number]["sku"]>().toEqualTypeOf<string>();

    resources.orders.consume({
      id: "orders.inline-check",
      handler: ({ message, delivery }) => {
        expectTypeOf(message.placedAt).toEqualTypeOf<Date>();
        expectTypeOf(message.priority).toEqualTypeOf<"normal" | "urgent">();
        expectTypeOf(message.lines[0]!.sku).toEqualTypeOf<string & z.core.$brand<"Sku">>();
        expectTypeOf(delivery.attempt).toEqualTypeOf<number>();
      }
    });
  });

  it("rejects wrong messages at compile time", () => {
    const message = { orderId: "o-1", lines: [{ sku: "A-1", quantity: 1 }], placedAt: "2026-10-17T12:00:00Z" } as const;
    // Each call below is a deliberate type error; none of them is executed.
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- "low" is not a declared priority.
      void resources.orders.send({ ...message, priority: "low" });
      // @ts-expect-error -- excess properties are rejected for object literals.
      void resources.orders.send({ ...message, discount: 5 });
      // @ts-expect-error -- `lines` is required.
      void resources.orders.send({ orderId: "o-1", placedAt: "2026-10-17T12:00:00Z" });
      // @ts-expect-error -- the input side expects a string, not the decoded Date.
      void resources.orders.send({ ...message, placedAt: new Date() });
      // @ts-expect-error -- unknown resource alias.
      void resources.payments;
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("composes resources declared in other modules without losing types", () => {
    expectTypeOf(resources.images.id).toEqualTypeOf<"catalog-images">();
    expectTypeOf<Parameters<typeof resources.images.put>[0]>().toEqualTypeOf<string>();
  });

  it("types configuration values from their schemas", () => {
    expectTypeOf<typeof env.DATABASE_URL>().toEqualTypeOf<string>();
    expectTypeOf<typeof env.LOG_LEVEL>().toEqualTypeOf<"debug" | "info" | "warn">();
    expectTypeOf<typeof env.PORT>().toEqualTypeOf<number>();
  });

  it("derives client contracts from route registrations through type-only imports", () => {
    type Place = InferRouteContract<typeof placeOrder>;
    type Get = InferRouteContract<typeof getOrder>;
    expectTypeOf<Place["method"]>().toEqualTypeOf<"POST">();
    expectTypeOf<Place["body"]["priority"]>().toEqualTypeOf<"normal" | "urgent" | undefined>();
    expectTypeOf<Place["response"]>().toEqualTypeOf<
      | { readonly status: 202; readonly body: { orderId: string } }
      | { readonly status: 422; readonly body: { message: string } }
    >();
    expectTypeOf<Get["params"]>().toEqualTypeOf<{ readonly orderId: string }>();
  });
});

describe("type inference for HTTP routes", () => {
  const api = http.api({ id: "api", basePath: "/api" });

  it("infers path parameters, query and body types", () => {
    api.route({
      id: "items.update",
      method: "PATCH",
      path: "/stores/:storeId/items/:itemId",
      query: z.object({ dryRun: z.enum(["true", "false"]).transform(value => value === "true") }),
      body: z.object({ name: z.string() }),
      responses: { 204: z.null() },
      handler: ({ params, query, body, reply }) => {
        expectTypeOf(params).toEqualTypeOf<{ readonly storeId: string; readonly itemId: string }>();
        expectTypeOf(query.dryRun).toEqualTypeOf<boolean>();
        expectTypeOf(body.name).toEqualTypeOf<string>();
        return reply(204, null);
      }
    });
  });

  it("widens returned object literals, which is why handlers use reply()", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      api.route({
        id: "widened",
        method: "GET",
        path: "/widened",
        responses: { 200: z.object({ state: z.enum(["on", "off"]) }) },
        // @ts-expect-error -- TypeScript widens `200` to `number` and "on" to `string` here; see RouteReply.
        handler: () => ({ status: 200, body: { state: "on" } })
      });
      api.route({
        id: "as-const",
        method: "GET",
        path: "/as-const",
        responses: { 200: z.object({ state: z.enum(["on", "off"]) }) },
        // Object literals still work when the author pins the literals.
        handler: () => ({ status: 200, body: { state: "on" } }) as const
      });
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("rejects routes whose declaration and handler disagree", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      api.route({
        id: "a",
        method: "GET",
        path: "/a/:id",
        // @ts-expect-error -- the params schema must declare exactly the path parameters.
        params: z.object({ orderId: z.string() }),
        responses: { 200: z.null() },
        handler: ({ reply }) => reply(200, null)
      });
      api.route({
        id: "b",
        method: "GET",
        path: "/b",
        // @ts-expect-error -- GET routes cannot declare a body.
        body: z.object({ x: z.string() }),
        responses: { 200: z.null() },
        handler: ({ reply }) => reply(200, null)
      });
      api.route({
        id: "c",
        method: "POST",
        path: "/c",
        responses: { 201: z.object({ id: z.string() }) },
        // @ts-expect-error -- 200 is not a declared status.
        handler: ({ reply }) => reply(200, { id: "1" })
      });
      api.route({
        id: "d",
        method: "POST",
        path: "/d",
        responses: { 201: z.object({ id: z.string() }) },
        // @ts-expect-error -- the body does not match the 201 schema.
        handler: ({ reply }) => reply(201, { id: 1 })
      });
    };
    expect(typeof neverCalled).toBe("function");
  });
});

describe("schema-library neutrality at the type level", () => {
  it("accepts any Standard Schema, including a hand-written one", () => {
    const plain = queue({
      id: "plain",
      schemaVersion: 1,
      message: {
        "~standard": {
          version: 1,
          vendor: "hand-written",
          validate: (value: unknown) => typeof value === "number" ? { value } : { issues: [{ message: "Expected a number." }] },
          types: undefined as unknown as { readonly input: number; readonly output: number }
        }
      }
    });
    expectTypeOf<Parameters<typeof plain.send>[0]>().toEqualTypeOf<number>();
    expect(plain.id).toBe("plain");
  });

  it("rejects values that are not Standard Schemas", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- a parse function alone is not a Standard Schema.
      queue({ id: "bad", schemaVersion: 1, message: { parse: (value: unknown) => value } });
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("keeps apps with many resources precisely typed", () => {
    const app = defineApp({
      name: "many",
      handlers: [],
      resources: {
        a: queue({ id: "a", schemaVersion: 1, message: z.object({ a: z.string() }) }),
        b: queue({ id: "b", schemaVersion: 1, message: z.object({ b: z.number() }) }),
        files: bucket({ id: "files", access: "private" })
      }
    });
    expectTypeOf<Parameters<typeof app.resources.a.send>[0]>().toEqualTypeOf<{ a: string }>();
    expectTypeOf<Parameters<typeof app.resources.b.send>[0]>().toEqualTypeOf<{ b: number }>();
    expectTypeOf(app.env).toEqualTypeOf<{}>();
  });
});