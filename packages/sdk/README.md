# @holqa/sdk

Declare a Holqa application's resources, configuration and handlers in TypeScript, with types inferred from source.

> **Status:** Implemented (application and resource model, HTTP routes, RPC procedures, middleware), private and
> unpublished. The API may change before the first release. `staticSite` is proposed. `@holqa/runtime-bun` executes
> routes and procedures; queue, storage and schedule delivery are planned.

Handler contexts use the standard `AbortSignal` type, so consumers need a `lib` or `types` setting that declares it
(DOM, `@types/node` or `@types/bun`).

`@holqa/sdk` depends only on `@holqa/core`. It is runtime-neutral and never imports compiler internals, runtime drivers
or provider code. See [package boundaries](../../docs/architecture/package-boundaries.md).

## Contents

| Export | Purpose |
| --- | --- |
| `defineApp()` | Validates and defines an application; exposes `app.resources` (exact handle types) and `app.env` (typed configuration). |
| `defineResources()`, `composeResources()` | Resource groups for registries split across modules. |
| `queue()`, `bucket()`, `schedule()`, `http.api()` | Resource declarations returning typed handles. |
| `secret()`, `variable()` | Configuration entries. |
| `consume()`, `onObjectCreated()`, `handle()` (on handles) | Declarative handler registration. |
| `route()`, `procedure()` (on `http.api` handles), `reply` | HTTP routes and RPC procedures; see the [runtime reference](../../docs/reference/runtime.md). |
| `middleware()`, `middleware.requires()` | Typed middleware for applications, APIs, routes and procedures. |
| `scoped()` | Application-scoped values (pools, clients) created once per runtime. |
| `InferRouteContract`, `InferProcedureContract` | Client-facing contracts of routes and procedures. |
| `QueueMessageInput`, `QueueMessageOutput`, `QueueConsumerFor`, `ResourceById`, ... | Types derived from handles. |

```ts
import { defineApp, queue, secret } from "@holqa/sdk";
import { z } from "zod";

const app = defineApp({
  name: "shop",
  handlers: ["./src/**/*.handler.ts"],
  resources: {
    orders: queue({ id: "order-placed", message: z.object({ orderId: z.string() }), schemaVersion: 1 })
  },
  env: { DATABASE_URL: secret(z.string().min(1)) }
});

export default app;
export const resources = app.resources;
```

Read the [application model](../../docs/concepts/application-model.md), [resource identity](../../docs/concepts/resource-identity.md)
and [composing applications](../../docs/concepts/composing-applications.md).

## Development

```bash
pnpm --filter @holqa/sdk build
pnpm --filter @holqa/sdk test
pnpm --filter @holqa/sdk typecheck   # enforces the type-level tests
```
