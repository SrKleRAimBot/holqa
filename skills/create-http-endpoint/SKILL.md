---
name: create-http-endpoint
description: Adds a typed HTTP route to a Holqa http.api resource with validated path parameters, query, headers and body, status-specific responses, middleware and OpenAPI metadata. Use when exposing a REST-style endpoint, a webhook receiver, or a streaming Fetch API handler from a Holqa application.
license: Apache-2.0
metadata:
  status: preview
---

# Creating a typed HTTP endpoint

> **Preview — not yet available.** HTTP routes, middleware and `holqa openapi generate` are **proposed** and not implemented. Code below is illustrative; method names such as `route` and `use` are placeholders.

## When to use

- Exposing a public or internal REST endpoint.
- Receiving webhooks from a third party.
- Returning streamed or native `Response` objects.

Prefer the `create-rpc-procedure` skill when the only caller is your own TypeScript frontend.

## Works today

Nothing in this workflow runs yet. You can check route IDs against the resource ID grammar (`^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`, at most 63 characters). `holqa openapi generate --json` reports `HOLQA_CLI_NOT_IMPLEMENTED`.

## Planned workflow

1. **Find the API resource** in `infra.ts` (for example `api: http.api({ id: "public-api", basePath: "/api" })`).
2. **Create a handler file** such as `src/orders/get-order.handler.ts`.
3. **Give the route a stable `id`** (`orders.get`). It identifies the operation in diagnostics and OpenAPI output.
4. **Declare every input with a schema:** `params`, `query`, `headers`, `body`. Inputs are validated before the handler runs.
5. **Declare responses per status code.** The handler's return type is checked against them.
6. **Add middleware** at the app, API or route level for authentication, rate limiting or tracing. Middleware can extend the typed context.
7. **Generate OpenAPI** with `holqa openapi generate` (proposed) and review the diff.

```ts
// src/orders/get-order.handler.ts — illustrative, proposed API
import { z } from "zod";
import { resources } from "../../infra";
import { requireUser } from "../auth/require-user";
import { findOrder } from "../db/orders";

export default resources.api.route({
  id: "orders.get",
  method: "GET",
  path: "/orders/:orderId",
  params: z.object({ orderId: z.string().uuid() }),
  query: z.object({ expand: z.enum(["items"]).optional() }),
  use: [requireUser],                       // adds `user` to the context
  responses: {
    200: z.object({ id: z.string(), status: z.string(), total: z.number() }),
    404: z.object({ error: z.literal("not_found") })
  },
  docs: { summary: "Fetch one order owned by the caller" },
  handler: async ({ params, user }) => {
    const order = await findOrder(params.orderId, user.id);
    if (!order)
      return { status: 404, body: { error: "not_found" } };
    return { status: 200, body: { id: order.id, status: order.status, total: order.total } };
  }
});
```

Webhooks: verify the signature over the **raw** body in middleware before parsing, and make the handler idempotent using the sender's event ID.

Streaming: return a standard `Response` with a `ReadableStream` body; Holqa is planned to interoperate with the Fetch API rather than wrap it.

## Pitfalls

- **Trusting the type of `body`.** Static types do not validate requests; always declare a schema.
- **Leaking internals.** Map database rows to the response schema; do not return them directly.
- **Authorization in the wrong place.** Authentication middleware proves identity; the handler must still check ownership (`user.id`).
- **Ambiguous routes.** `/orders/:id` and `/orders/export` can collide; the planned compiler reports ambiguous routes.
- **Non-idempotent `POST` retries.** Accept an idempotency key for operations that create resources.
- **Holqa identity assumptions.** Holqa does not provide an identity service; use your own middleware or an integration.

## Verification checklist

- [ ] The route has a unique, stable `id`.
- [ ] `params`, `query`, `headers` and `body` that the handler reads all have schemas.
- [ ] Every returned status code is declared in `responses`.
- [ ] Authentication and per-resource authorization are both enforced.
- [ ] Responses contain no secrets, stack traces or internal fields.
- [ ] Generated OpenAPI (once available) matches the intended public contract.
