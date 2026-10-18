import { z } from "zod";
import { resources } from "@/app/infra";
import {
  order,
  orderId,
  problem
} from "@/app/src/contracts";
import { authenticate } from "@/app/src/middleware";
import { orderStore } from "@/app/src/store";

/** Reads one order. */
export const getOrder = resources.api.route({
  id: "orders.get",
  method: "GET",
  path: "/orders/:orderId",
  params: z.object({ orderId }),
  responses: { 200: order, 404: problem },
  handler: async ({ params, scope, reply }) => {
    const found = (await scope.use(orderStore)).find(params.orderId);
    return found === undefined ? reply(404, { message: `Order ${params.orderId} does not exist.` }) : reply(200, found);
  }
});

/** Lists orders, optionally by status. */
export const listOrders = resources.api.route({
  id: "orders.list",
  method: "GET",
  path: "/orders",
  query: z.object({ status: z.enum(["placed", "cancelled"]).optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }),
  responses: { 200: z.array(order) },
  handler: async ({ query, scope, reply }) => reply(200, (await scope.use(orderStore)).list(query.status).slice(0, query.limit))
});

/** Places an order for the signed-in user. */
export const placeOrder = resources.api.route({
  id: "orders.place",
  method: "POST",
  path: "/orders",
  middleware: [authenticate],
  body: z.object({ sku: z.string().min(1), quantity: z.number().int().positive() }),
  responses: { 201: order },
  handler: async ({ body, context, scope, log, reply }) => {
    // `context.user` comes from the route's middleware and `context.requestId`
    // from the application's; both are typed.
    const placed = (await scope.use(orderStore)).place({ ...body, placedBy: context.user.id });
    log.info("order placed", { orderId: placed.orderId, requestId: context.requestId });
    return reply(201, placed, { location: `/api/orders/${placed.orderId}` });
  }
});

/** Echoes a tag after a delay, so tests can overlap requests. */
export const echo = resources.api.route({
  id: "echo",
  method: "GET",
  path: "/echo/:tag",
  query: z.object({ delayMs: z.coerce.number().int().min(0).max(1000).default(0) }),
  responses: { 200: z.object({ tag: z.string(), requestId: z.string() }) },
  handler: async ({ params, query, context, signal, reply }) => {
    const tag = params.tag;
    await Bun.sleep(query.delayMs);
    signal.throwIfAborted();
    return reply(200, { tag, requestId: context.requestId });
  }
});

/** Streams server-sent events. Streaming responses are passed through unvalidated. */
export const events = resources.api.route({
  id: "events.stream",
  method: "GET",
  path: "/events",
  responses: { 200: z.string() },
  handler: () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        for (const event of ["placed", "paid", "shipped"]) {
          controller.enqueue(encoder.encode(`data: ${event}\n\n`));
          await Bun.sleep(1);
        }
        controller.close();
      }
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
});