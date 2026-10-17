# oRPC and Hono

> **Status:** Planned. No oRPC or Hono integration exists. All code on this page is illustrative; the API is proposed and may change.

Holqa does not require developers to use one HTTP framework, and it does not define a proprietary RPC protocol. HTTP and RPC are trigger types within the resource graph ([triggers and execution](../concepts/triggers-and-execution.md)), and existing frameworks should be usable as their implementation.

## The common ground: the Fetch API

Holqa's HTTP execution model is designed around the standard Fetch API (`Request` → `Response`). Hono and oRPC both expose Fetch-compatible handlers. That makes the integration boundary simple: Holqa routes a request that matches an HTTP resource's base path to a Fetch handler supplied by the framework.

| Holqa owns | The framework owns |
| --- | --- |
| Resource identity (`id`), base path, and manifest entry | Routing within the base path |
| Typed resource handles available to handler code | Request parsing, middleware chain, response building |
| Local development server and single-origin routing | Framework-specific features |
| Configuration and secrets | — |

## Hono

The following code is illustrative.

```ts
// Illustrative, proposed API.
import { Hono } from "hono";
import { resources } from "../../infra";

const app = new Hono()
  .post("/orders", async (c) => {
    const body = await c.req.json();
    // Validate body here (for example with a Hono validator), then use typed handles:
    await resources.orders.send({ orderId: body.orderId, priority: "normal" });
    return c.json({ accepted: true }, 202);
  });

export default resources.api.mount({ id: "api.hono", fetch: app.fetch });
```

Limitations to state honestly: when a Hono app implements routes, Holqa can only describe its contract (for OpenAPI and clients) to the extent the app exposes that information. Routes defined only inside Hono are opaque to the compiler unless an adapter extracts them, for example from Hono's OpenAPI tooling.

## oRPC

oRPC provides typed procedures with input and output schemas. The planned integration (`packages/integrations/orpc`) should let an oRPC router serve as the implementation of an `http.api` resource's RPC mount, so that teams already using oRPC keep their procedures and clients.

```ts
// Illustrative, proposed API.
import { os } from "@orpc/server";
import { z } from "zod";
import { resources } from "../../infra";

const router = {
  createOrder: os
    .input(z.object({ orderId: z.string() }))
    .handler(async ({ input }) => {
      await resources.orders.send({ orderId: input.orderId, priority: "normal" });
      return { accepted: true };
    })
};

export default resources.api.rpc.mount({ id: "api.rpc", router });
```

Open questions (**Proposed**):

- Whether Holqa's generated clients wrap oRPC's own client or whether oRPC's client is used directly.
- How oRPC procedure contracts are reflected in the manifest and OpenAPI output.
- How Holqa middleware and oRPC middleware compose.

## Native handlers

For teams without an existing framework, Holqa's own route and procedure definitions (illustrated in [triggers and execution](../concepts/triggers-and-execution.md#http)) remain available and give the compiler full contract information.

## Related

- [Integrations](index.md)
- [Triggers and execution](../concepts/triggers-and-execution.md)
- [TanStack](tanstack.md)
- [Effect](effect.md)
