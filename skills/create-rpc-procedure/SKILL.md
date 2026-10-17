---
name: create-rpc-procedure
description: Adds a typed RPC query or mutation to a Holqa http.api resource and consumes it from a frontend through a generated, browser-safe client, optionally with TanStack Query options. Use when your own TypeScript frontend needs to call backend logic with end-to-end inferred types.
license: Apache-2.0
metadata:
  status: preview
---

# Creating a typed RPC procedure

> **Preview — not yet available.** RPC procedures, client generation (`@holqa/client`) and the TanStack Query integration are **proposed/planned** and not implemented. Code below is illustrative; method and package names may change.

## When to use

- A Vite or other TypeScript frontend needs typed calls to the backend.
- You want query keys and cache invalidation derived from the backend contract.

Prefer `create-http-endpoint` for public, non-TypeScript or third-party consumers. Existing oRPC routers are planned to be supported through an integration rather than replaced.

## Works today

Nothing in this workflow runs yet. Procedure IDs follow the resource ID grammar (`orders.list`, `orders.create`).

## Planned workflow

1. **Enable RPC** on the API resource: `http.api({ id: "public-api", basePath: "/api", rpc: { path: "/rpc" } })`.
2. **Choose query or mutation.** Queries must be free of side effects; mutations change state.
3. **Declare `input` and `output` schemas.** Input is validated on the server; output defines the public contract.
4. **Write the procedure** in a `*.handler.ts` file with a stable `id`.
5. **Generate the client** (planned compiler output). It contains procedure IDs, schemas and transport only.
6. **Use it in the frontend** directly or through the planned TanStack Query integration.

```ts
// src/api/create-order.handler.ts — illustrative, proposed API
import { z } from "zod";
import { resources } from "../../infra";
import { insertOrder } from "../db/orders";

export default resources.api.mutation({
  id: "orders.create",
  input: z.object({
    sku: z.string().min(1),
    quantity: z.number().int().positive(),
    idempotencyKey: z.string().uuid()      // retried requests do not duplicate orders
  }),
  output: z.object({ orderId: z.string().uuid() }),
  handler: async ({ input }) => ({ orderId: await insertOrder(input) })
});
```

```ts
// web/src/orders.ts — illustrative; package names are placeholders
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
