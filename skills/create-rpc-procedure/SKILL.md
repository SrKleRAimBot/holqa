---
name: create-rpc-procedure
description: Adds a typed RPC query or mutation to a Holqa http.api resource and consumes it from a frontend through a generated, browser-safe client, optionally with TanStack Query options. Use when your own TypeScript frontend needs to call backend logic with end-to-end inferred types.
license: Apache-2.0
metadata:
  status: preview
---

# Creating a typed RPC procedure

> **Preview.** RPC procedures and their execution by `@holqa/runtime-bun` (`holqa.rpc/1` protocol) are **implemented** in private, unpublished packages; the API may change. Client generation (`@holqa/client`) and the TanStack Query integration are **planned** and not implemented; the frontend code below is illustrative. See the [runtime reference](../../docs/reference/runtime.md#rpc-procedures).

## When to use

- A Vite or other TypeScript frontend needs typed calls to the backend.
- You want query keys and cache invalidation derived from the backend contract.

Prefer `create-http-endpoint` for public, non-TypeScript or third-party consumers. Existing oRPC routers are planned to be supported through an integration rather than replaced.

## Workflow

1. **Use an API resource.** Every `http.api` serves its procedures at `<basePath>/rpc/<id>`; no extra option is needed.
2. **Choose `operation: "query"` or `"mutation"`.** Queries must be free of side effects (they are also callable with `GET`); mutations change state and accept `POST` only.
3. **Declare `input` (optional) and `output` schemas.** Input is validated on the server (`400 HOLQA_INPUT_INVALID` in a failure envelope); output defines the public contract and is validated before it is sent.
4. **Write the procedure** in a `*.handler.ts` file with a stable `id`, optionally with `middleware: [...]`.
5. **Call it** with `POST <basePath>/rpc/<id>` and body `{ "input": ... }`; the response is `{ "format": "holqa.rpc/1", "ok": true, "output": ... }`.
6. **Generate the client** (planned compiler output) and use it in the frontend directly or through the planned TanStack Query integration.

```ts
// src/api/create-order.handler.ts
import { z } from "zod";
import { resources } from "../../infra";
import { insertOrder } from "../db/orders";

export const createOrder = resources.api.procedure({
  id: "orders.create",
  operation: "mutation",
  input: z.object({
    sku: z.string().min(1),
    quantity: z.number().int().positive(),
    idempotencyKey: z.uuid() // retried requests do not duplicate orders
  }),
  output: z.object({ orderId: z.uuid() }),
  handler: async ({ input }) => ({ orderId: await insertOrder(input) })
});
```

The following code is illustrative. The API is proposed, not implemented, and may change.

```ts
// web/src/orders.ts — package names are placeholders
import { createQueryOptions } from "@holqa/tanstack-query";
import { createClient } from "./generated/holqa-client";

const api = createQueryOptions(createClient({ baseUrl: "/api/rpc" }));

export const recentOrders = (limit: number) => api.orders.list.queryOptions({ limit });
```

See [`examples/fullstack-vite`](../../examples/fullstack-vite/) for a complete illustrative layout.

## Browser-safety rules

- Frontend code imports **only** the generated client. Never import `infra.ts`, handler modules or anything that reads `config`.
- The generated client must not contain handler code, internal procedures, credentials or secrets.
- Client-side validation is a convenience; the server validates every input again.

## Pitfalls

- Returning database rows instead of the declared `output` shape (leaks internal columns).
- Side effects inside a query; caches and retries will repeat them.
- Mutations without an idempotency key when the client may retry.
- Renaming a procedure `id`: deployed clients still call the old one. Treat it as a breaking change (see `schema-evolution`).
- Checking authorization only in the UI.

## Verification checklist

- [ ] Each procedure has a unique, stable `id` and declared `input`/`output` schemas.
- [ ] Queries have no side effects; mutations that create data are idempotent.
- [ ] The frontend bundle does not import `infra.ts`, `src/**` or server-only packages.
- [ ] Authorization is enforced inside the procedure or its middleware.
- [ ] Contract changes are reviewed for compatibility with already-deployed clients.
- [ ] `holqa build --manifest` records the procedure as an `http.procedure` trigger.
