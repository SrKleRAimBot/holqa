---
name: define-resources
description: Declares Holqa infrastructure resources in infra.ts — http.api, queue, bucket, schedule, staticSite, secret and variable — with stable logical IDs, schemas and delivery requirements. Use when adding, renaming, splitting or removing a resource declaration, or when composing a registry from several files.
license: Apache-2.0
metadata:
  status: preview
---

# Defining infrastructure resources

> **Preview — not yet published.** `defineApp`, `defineResources`, `composeResources`, `queue`, `bucket`, `schedule`, `http.api` (with routes and RPC procedures, see `create-http-endpoint` and `create-rpc-procedure`), `secret` and `variable` are implemented in the Holqa repository's `@holqa/sdk`, which is not published to npm yet. `staticSite` is **proposed**; code that uses it is illustrative.

## When to use

- Adding a new queue, bucket, schedule, API, static site, secret or variable.
- Changing resource requirements (retries, access, overlap policy).
- Renaming, moving or removing a declaration.

## Works today

Resource IDs are validated by `parseResourceId` in `@holqa/core` (repository-internal). The grammar, an initial proposal that may be revised before 1.0:

- Pattern `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`, at most 63 characters.
- Valid: `order-processing`, `orders.process`, `daily-cleanup`. Invalid: `Orders`, `order_processing`, `-orders`, `orders.`.
- Failures report `HOLQA_RESOURCE_ID_INVALID`.

In the repository's `@holqa/sdk`, factories validate their declarations when called, literal IDs are checked at compile time, and `defineApp` rejects duplicate IDs (`HOLQA_RESOURCE_ID_DUPLICATE`) at compile time and run time, reporting every problem at once.

## Planned workflow

1. **Pick the resource kind** that matches the required behavior, not a vendor product.
2. **Choose a permanent `id`.** It is the persistent identity; the object key (`orders`) is just a TypeScript handle.
3. **Declare requirements, not provider settings.** State schema, retries, dead-lettering, access or overlap. Do not add provider-specific option bags; bindings are validated separately.
4. **Attach schemas** for any data that crosses a trust boundary (queue messages, env values).
5. **Keep it pure.** No I/O, clocks, randomness or environment reads during declaration.
6. **Compose if large.** Split resources into modules with `defineResources` and combine them with `composeResources`, which rejects duplicate aliases (plain spread silently keeps the last one).

```ts
// infra.ts — illustrative: staticSite is proposed; the rest is implemented but unpublished
import { bucket, defineApp, http, queue, schedule, secret, staticSite, variable } from "@holqa/sdk";
import { z } from "zod";

const app = defineApp({
  name: "commerce",
  handlers: ["./src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "public-api", basePath: "/api" }), // procedures are served at /api/rpc/<id>
    orders: queue({
      id: "order-processing",
      message: z.object({ orderId: z.string(), priority: z.enum(["normal", "urgent"]) }),
      schemaVersion: 1,
      delivery: { maxAttempts: 5, deadLetter: true }
    }),
    uploads: bucket({ id: "customer-uploads", access: "private" }),
    cleanup: schedule({ id: "daily-cleanup", cron: "0 2 * * *", timezone: "UTC", overlap: "skip" }),
    web: staticSite({ id: "web", root: "./web", build: { command: "bun run build", output: "dist" }, spaFallback: true })
  },
  env: {
    DATABASE_URL: secret(z.string().min(1)),
    LOG_LEVEL: variable(z.enum(["debug", "info", "warn", "error"]), { default: "info" })
  }
});

export default app;
export const resources = app.resources;
export const config = app.env;
```

Composition (illustrative):

```ts
// resources/billing.ts
export const billingResources = {
  invoices: queue({ id: "invoice-generation", message: invoiceMessage, schemaVersion: 1 })
};

// infra.ts
resources: { ...coreResources, ...billingResources }
```

## Renaming and removing

- **Rename the handle freely** (`orders` → `orderQueue`); keep the `id`.
- **Changing an `id` creates a new resource.** Existing messages, objects and schedules stay with the old one. Plan a migration instead.
- **Removing a declaration** must surface as an explicit planned deletion that a human approves. Never delete physical infrastructure implicitly, and never write tooling that does.

## Pitfalls

- Using the same `id` twice. `defineApp` reports duplicate resource IDs (`HOLQA_RESOURCE_ID_DUPLICATE`); the compiler (`holqa inspect`, `holqa build --manifest`) reports duplicate handler IDs (`HOLQA_HANDLER_ID_DUPLICATE`).
- Generating IDs dynamically (`` `queue-${env}` ``); environments are a binding concern, not part of the ID.
- Declaring a queue without a `message` schema, so consumers cannot validate input.
- Putting secrets' values in `infra.ts`; declare the schema only.
- Expecting every provider to support every option; unsupported capabilities must fail validation (see `validate-infrastructure-bindings`).

## Verification checklist

- [ ] Every `id` matches the grammar and is unique across the application.
- [ ] No `id` changed unintentionally (compare with the previous version).
- [ ] Queue messages and env values have schemas; queues have `schemaVersion`.
- [ ] `infra.ts` performs no I/O and has no provider-specific configuration.
- [ ] Removed declarations are called out for explicit human review.
