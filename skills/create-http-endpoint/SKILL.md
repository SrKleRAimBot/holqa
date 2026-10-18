---
name: create-http-endpoint
description: Adds a typed HTTP route to a Holqa http.api resource with validated path parameters, query, headers and body, status-specific responses, middleware and OpenAPI metadata. Use when exposing a REST-style endpoint, a webhook receiver, or a streaming Fetch API handler from a Holqa application.
license: Apache-2.0
metadata:
  status: preview
---

# Creating a typed HTTP endpoint

> **Preview.** Routes, `reply`, middleware and their execution by `@holqa/runtime-bun` are **implemented** in private, unpublished packages; the API may change. OpenAPI generation (`holqa openapi generate`) and `holqa dev` are **proposed** and not implemented. See the [runtime reference](../../docs/reference/runtime.md#http-routes).

## When to use

- Exposing a public or internal REST endpoint.
- Receiving webhooks from a third party.
- Returning streamed or native `Response` objects.

Prefer the `create-rpc-procedure` skill when the only caller is your own TypeScript frontend.

## Workflow

1. **Find the API resource** in `infra.ts` (for example `api: http.api({ id: "public-api", basePath: "/api" })`). Register routes through `app.resources` so application middleware's context is typed.
2. **Create a handler file** matched by the application's `handlers` patterns, such as `src/orders/get-order.handler.ts`, and export the registration.
3. **Give the route a stable `id`** (`orders.get`). It identifies the handler in the manifest, logs and diagnostics.
4. **Declare every input with a schema:** `params`, `query`, `headers` (lowercase names), `body` (JSON; not allowed on `GET` and `DELETE`). Inputs are validated before the handler runs; failures answer `400 HOLQA_INPUT_INVALID` with per-field issues.
5. **Declare responses per status code** and return `reply(status, body)`. Undeclared statuses and invalid bodies answer `500 HOLQA_RESPONSE_INVALID`.
6. **Add middleware** at the app (`defineApp({ middleware })`), API (`http.api({ middleware })`) or route level (`middleware: [...]`). Middleware can extend the typed context with `next({ ... })`.
7. **Compile and run:** `holqa build --manifest`, then serve with `createRuntime(await loadCompiledApplication({ root }))` and `serve(runtime)` from `@holqa/runtime-bun`.

```ts
// src/orders/get-order.handler.ts
import { z } from "zod";
import { resources } from "../../infra";
import { requireUser } from "../auth/require-user"; // middleware({ name, handle: ... next({ user }) })
import { findOrder } from "../db/orders";

export const getOrder = resources.api.route({
  id: "orders.get",
  method: "GET",
  path: "/orders/:orderId",
  params: z.object({ orderId: z.uuid() }),
  query: z.object({ expand: z.enum(["items"]).optional() }),
  middleware: [requireUser], // adds `user` to `context`
  responses: {
    200: z.object({ id: z.string(), status: z.string(), total: z.number() }),
    404: z.object({ error: z.literal("not_found") })
  },
  handler: async ({ params, context, reply }) => {
    const order = await findOrder(params.orderId, context.user.id);
    if (!order)
      return reply(404, { error: "not_found" });
    return reply(200, { id: order.id, status: order.status, total: order.total });
  }
});
```

To reject a request from middleware or a handler, throw `new HttpRejectedError(401, "Sign in to continue.")` from `@holqa/core`; the caller gets that status and message, never a stack trace.

Webhooks: middleware sees the unread request. Verify the signature over the raw body with `await request.clone().text()` (cloning leaves the body for the route's `body` schema), and make the handler idempotent using the sender's event ID.

Streaming: return a standard `Response` with a `ReadableStream` body. Its status must be declared in `responses`, but its body is not validated.

## Pitfalls

- **Trusting the type of `body`.** Static types do not validate requests; always declare a schema.
- **Leaking internals.** Map database rows to the response schema; do not return them directly.
- **Authorization in the wrong place.** Authentication middleware proves identity; the handler must still check ownership (`context.user.id`).
- **Conflicting routes.** Two routes with the same method and path shape (`/orders/:id` and `/orders/:orderId`) conflict: `HOLQA_ROUTE_CONFLICT`. A static segment and a parameter (`/orders/export`, `/orders/:id`) do not conflict: the static segment wins. Paths under `<basePath>/rpc/` can collide with procedures.
- **Ignoring `signal`.** A handler that ignores its abort signal keeps running after its caller received a timeout.
- **Non-idempotent `POST` retries.** Accept an idempotency key for operations that create resources.
- **Holqa identity assumptions.** Holqa does not provide an identity service; use your own middleware or an integration.

## Verification checklist

- [ ] The route has a unique, stable `id`.
- [ ] `params`, `query`, `headers` and `body` that the handler reads all have schemas.
- [ ] Every returned status code is declared in `responses`.
- [ ] Authentication and per-resource authorization are both enforced.
- [ ] Responses contain no secrets, stack traces or internal fields.
- [ ] `holqa build --manifest` succeeds and a request through `runtime.fetch` returns the expected status.
