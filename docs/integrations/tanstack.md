# TanStack

> **Status:** Planned. No TanStack integration exists. All code on this page is illustrative; the API is proposed and may change.

Holqa plans different levels of integration with three TanStack libraries.

| Library | Holqa's role | Status |
| --- | --- | --- |
| TanStack Query | Provide typed query/mutation options and query keys from generated clients. | Planned (`packages/integrations/tanstack-query`) |
| TanStack Router | None. TanStack Router continues to own frontend routing. | — |
| TanStack Start | Future full-stack hosting integration. | Future; not an initial requirement |

## TanStack Query

Generated browser-safe clients ([type safety and schemas](../concepts/type-safety-and-schemas.md#generated-browser-safe-clients)) expose typed RPC procedures and HTTP operations. The TanStack Query integration would turn them into `queryOptions` and mutation options with stable query keys.

```ts
// Illustrative, proposed API.
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./generated/holqa-client";

function Order({ orderId }: { orderId: string }) {
  const order = useQuery(api.orders.get.queryOptions({ orderId }));
  const cancel = useMutation(api.orders.cancel.mutationOptions());
  // order.data is typed from the procedure's output schema.
}
```

Design points:

- **Query vs. mutation** comes from the procedure's classification ([RPC](../concepts/triggers-and-execution.md#rpc)). Only queries produce query options.
- **Query keys** are derived deterministically from the procedure identifier and input, so invalidation can target a procedure or a specific input.
- **Browser safety.** The integration consumes generated clients only; it never imports `infra.ts`, handlers, or server code.
- **No reactivity promise.** Data stays fresh through TanStack Query's normal mechanisms (invalidation, refetching). Holqa does not promise automatic, Convex-style live updates from the database.

## TanStack Router

Holqa does not provide a router and will not replace TanStack Router. Applications use TanStack Router (or any router) for frontend routing, and call Holqa contracts from loaders or components through generated clients and TanStack Query options.

## TanStack Start

TanStack Start is a full-stack framework with its own server runtime. A future integration could let a Start application be served as part of a Holqa application, or let Start server functions use Holqa resource handles. This is explicitly **not** an initial requirement; the initial frontend story is a static frontend built with [Vite](vite.md).

## Related

- [Integrations](index.md)
- [Vite](vite.md)
- [oRPC and Hono](orpc-and-hono.md)
