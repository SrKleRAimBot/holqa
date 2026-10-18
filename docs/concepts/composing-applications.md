# Composing applications

> **Status:** Implemented — `defineResources`, `composeResources` and cross-module type inference in `@holqa/sdk`. Handler discovery from the `handlers` patterns is **Implemented** in the compiler (`holqa inspect`, `holqa build --manifest`).

Large applications should not need one enormous `infra.ts`. Because `infra.ts` is an ordinary TypeScript module, a registry can be split across modules with normal imports and exports. Types flow through those imports: no code generation, development server or external infrastructure is involved.

## Pattern 1: one resource group per bounded context

Declare each context's resources in its own module with `defineResources`, which returns its argument unchanged but gives the group a precise type.

The following code uses the implemented `@holqa/sdk` API.

```ts
// src/catalog/resources.ts
import { bucket, defineResources, queue } from "@holqa/sdk";
import { z } from "zod";

export const catalogResources = defineResources({
  images: bucket({ id: "catalog-images", access: "public-read" }),
  reindex: queue({ id: "catalog-reindex", message: z.object({ productId: z.string() }), schemaVersion: 1 })
});
```

## Pattern 2: combine groups with `composeResources`

```ts
// infra.ts
import { composeResources, defineApp, secret } from "@holqa/sdk";
import { z } from "zod";

import { catalogResources } from "./src/catalog/resources";
import { orderResources } from "./src/orders/resources";

const app = defineApp({
  name: "shop",
  handlers: ["./src/**/*.handler.ts"],
  resources: composeResources(orderResources, catalogResources),
  env: { DATABASE_URL: secret(z.string().min(1)) }
});

export default app;
export const resources = app.resources;
export const env = app.env;
```

`composeResources` rejects an alias declared by two groups, at compile time for literal keys and at run time for all keys. Object spread (`{ ...orderResources, ...catalogResources }`) also works and keeps every type, but it silently keeps the last of two equal aliases, which drops a resource from the application.

Identifiers must stay unique across groups. `defineApp` reports duplicates from different groups like duplicates in one record.

## Pattern 3: shared contracts in their own modules

Put schemas that producers, consumers and declarations share in a contracts module. `infra.ts` imports them; handlers can import the schemas or derive types from the handle.

```ts
// src/contracts/order.ts
import { z } from "zod";

export const orderPlaced = z.object({
  orderId: z.string(),
  placedAt: z.iso.datetime().transform(value => new Date(value))
});
```

## Pattern 4: handlers and producers import handles

```ts
// src/orders/process-order.handler.ts
import { resources } from "../../infra";

export default resources.orders.consume({
  id: "orders.process",
  handler: ({ message }) => {
    message.placedAt; // Date: the schema's output type
  }
});
```

```ts
// src/orders/place-order.ts
import type { QueueMessageInput } from "@holqa/sdk";

import { resources } from "../../infra";

export async function placeOrder(order: QueueMessageInput<typeof resources.orders>) {
  await resources.orders.send(order); // the schema's input type: placedAt is an ISO string
}
```

When `orderPlaced` changes, the next type check updates `send`, `consume` and `QueueMessageInput` everywhere they are used. `QueueConsumerFor<typeof resources.orders>` types a consumer function written apart from its registration.

## Rules that keep composition safe

| Rule | Why |
| --- | --- |
| `infra.ts` never imports handler modules. | Declarations stay free of business logic and the module graph stays acyclic. |
| Resource groups import schemas, not handles from `infra.ts`. | A group imported by `infra.ts` that imported `infra.ts` back would be a cycle. |
| Do not use handles or `env` at module top level. | Nothing is bound while modules load; such use fails with `HOLQA_RUNTIME_NOT_BOUND`. |
| A handle belongs to one application. | Passing the same handle to two `defineApp` calls fails with `HOLQA_DECLARATION_INVALID`. Create separate handles (for example in a factory function) when two applications need the same declaration. |
| Composition is deterministic. | Resource order in the descriptor follows declaration order, so equal sources produce equal descriptors. |

## Related

- [Application model](application-model.md)
- [Resource identity](resource-identity.md)
- [Resource model architecture](../architecture/resource-model.md)
