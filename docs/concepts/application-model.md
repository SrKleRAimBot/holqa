# Application model

> **Status:** Implemented in part. `defineApp`, `defineResources`, `composeResources`, the `queue`, `bucket`, `schedule` and `http.api` factories, `secret` and `variable`, typed handles, handler registration for queues, buckets and schedules, and HTTP routes, RPC procedures and typed middleware exist in `@holqa/sdk`. Handler discovery and compilation into a manifest are **Implemented** in `@holqa/compiler` and the CLI. `@holqa/runtime-bun` executes HTTP routes and RPC procedures ([runtime reference](../reference/runtime.md)). `staticSite` and the delivery of queue, storage and schedule events are **Proposed** or **Planned**.

A Holqa application is a set of **logical resources** declared in a registry module, plus **handler modules** that contain business logic. This document describes the registry (`infra.ts` and `defineApp`), how resources are identified, how typed handles work, and how resource lifecycles relate to code. The internal representation is described in [resource model](../architecture/resource-model.md).

## `infra.ts`: the application registry

Every Holqa application has a conventional entry point named `infra.ts`. It is an ordinary TypeScript module, not a configuration language, and it is the canonical registry of the application's infrastructure:

- It declares resources and configuration.
- It declares where handler modules live.
- It exports typed resource handles for use by handlers.
- It contains **no business logic** and performs **no provisioning**.

The following code uses the implemented `@holqa/sdk` API.

```ts
import { bucket, defineApp, http, queue, schedule, secret, variable } from "@holqa/sdk";
import { z } from "zod";

const app = defineApp({
  name: "commerce",
  description: "Storefront and order processing.",
  handlers: ["./src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "public-api", basePath: "/api", docs: { title: "Commerce API", version: "1.0.0" } }),
    orders: queue({
      id: "order-processing",
      message: z.object({
        orderId: z.string(),
        priority: z.enum(["normal", "urgent"])
      }),
      schemaVersion: 1,
      delivery: { maxAttempts: 5, deadLetter: true }
    }),
    uploads: bucket({ id: "customer-uploads", access: "private" }),
    cleanup: schedule({ id: "daily-cleanup", cron: "0 2 * * *", timezone: "UTC", overlap: "skip" })
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

Any [Standard Schema](https://standardschema.dev) implementation works; Zod is used in the examples.

## `defineApp`

`defineApp` takes a single declaration object and returns an application.

| Field | Required | Purpose |
| --- | --- | --- |
| `name` | Yes | The application's name, in [identifier grammar](resource-identity.md). |
| `description` | No | A short human-readable description. |
| `handlers` | No | Glob patterns for handler modules, relative to `infra.ts`: a list, or `{ include, exclude }`. Absolute paths and `..` are rejected. Discovery itself is done by the compiler (`holqa inspect`, `holqa build --manifest`), not by `defineApp`. |
| `resources` | Yes | A record of resource handles. Property names are local aliases; each resource's `id` is its identity. |
| `env` | No | Typed configuration: `secret(schema)` for sensitive values, `variable(schema, { default })` for non-sensitive ones. Names must be valid environment variable names. |

The returned application exposes:

| Property | Type | Behaviour |
| --- | --- | --- |
| `resources` | Exactly the record passed in | The same handles, so their types flow to every importing module. |
| `env` | `{ readonly [Name]: InferOutput<Schema> }` | Getters that read the value from the runtime binding. Reading one with no binding fails with `HOLQA_RUNTIME_NOT_BOUND`. |
| `name` | `string` | The application's name. |

`defineApp` is **pure**: it performs no I/O, reads no clock, randomness or environment variable, opens no connection and creates no infrastructure. Calling it twice with equal input yields equivalent descriptors ([ADR 0003](../architecture/decisions/0003-explicit-resource-declarations.md)).

It validates the whole definition and throws one `HolqaError` that lists every problem: an invalid name, malformed handler patterns, values that are not resources, resources that already belong to another application, malformed configuration entries, and duplicate resource identifiers. Duplicate literal identifiers are also a compile-time error ([ADR 0019](../architecture/decisions/0019-declaration-time-validation.md)).

## Logical resources

A logical resource describes **what** the application needs and **which guarantees** it requires, not how a provider implements it. A queue declaration states its message schema, schema version, attempt limit and dead-letter requirement. It does not name a cloud queue service or carry provider configuration; the core model has no open configuration dictionaries in which such settings could hide.

| Factory | Declares | Status |
| --- | --- | --- |
| `queue({ id, message, schemaVersion, delivery? })` | Message schema, schema version, `maxAttempts`, `deadLetter`; requires at-least-once delivery. | **Implemented** |
| `bucket({ id, access })` | Access policy (`private`, `public-read`). | **Implemented** |
| `schedule({ id, cron, timezone, overlap })` | Five-field cron expression, IANA time zone, overlap policy (`skip`, `allow`). | **Implemented** |
| `http.api({ id, basePath, docs? })` | Base path, documentation metadata and API middleware; routes and RPC procedures are registered on its handle. | **Implemented** |
| `staticSite(...)` | Source root, build command and output, SPA fallback. | Proposed |
| `secret(schema)` / `variable(schema, { default? })` | Configuration value schema; default for variables only. | **Implemented** |

Future kinds (topics, WebSocket endpoints, workflows) are listed in [triggers and execution](triggers-and-execution.md). Adding one means adding an entry to the typed kind registry in `@holqa/core` ([resource model](../architecture/resource-model.md#adding-a-kind)).

How a logical resource becomes real infrastructure is the job of a binding; see [infrastructure providers](infrastructure-providers.md) and [ADR 0005](../architecture/decisions/0005-infrastructure-independent-resource-contracts.md).

## Stable identifiers

Every resource and every handler has an explicit, stable identifier. The TypeScript property name (`orders`) is a local alias for convenience; the identifier (`order-processing`) is the persistent identity ([ADR 0004](../architecture/decisions/0004-stable-logical-resource-identities.md)). The full rules, and how they are checked at compile time and run time, are in [resource identity](resource-identity.md).

## Typed handles

Each declared resource is a typed handle, exposed again through `app.resources`. Handle types are inferred from the declaration, so producers and consumers share one schema without a hand-written interface or generated code. Producers use the schema's **input** type; consumers receive its **output** type.

The following code uses the implemented `@holqa/sdk` API.

```ts
// Producer: any module
import { resources } from "../../infra";

await resources.orders.send({ orderId: "order_123", priority: "urgent" });
// A type error if priority is not "normal" | "urgent".
```

```ts
// Consumer: src/orders/process.handler.ts
import { resources } from "../../infra";

export default resources.orders.consume({
  id: "orders.process",
  handler: async ({ message, delivery }) => {
    console.log(message.orderId, delivery.attempt);
  }
});
```

| Handle | Operations | Handler registration |
| --- | --- | --- |
| `QueueHandle<Id, Schema>` | `send(message: InferInput<Schema>)` validates the message, then hands its input form to the bound driver. | `consume({ id, concurrency?, handler })` |
| `BucketHandle<Id>` | `put(key, body, { contentType? })`, `get(key)` | `onObjectCreated({ id, prefix?, handler })` |
| `ScheduleHandle<Id>` | none | `handle({ id, handler })` |
| `HttpApiHandle<Id, Context>` | none | `route({ id, method, path, ..., handler })`, `procedure({ id, operation, input?, output, handler })` |

Handles are **operations** on a resource, not the resource itself. Declaring a handle opens nothing. When an operation runs, the handle resolves a driver from the runtime binding installed on its application: a local emulator, a test double or a driver for an external service ([ADR 0020](../architecture/decisions/0020-runtime-binding-resolution.md)). Using a handle with no binding fails with `HOLQA_RUNTIME_NOT_BOUND`. `@holqa/runtime-bun` installs a binding when it starts; its default binding serves HTTP APIs and configuration only. Local drivers for queues and buckets are **Planned**.

Type helpers for code that works with handles: `QueueMessageInput<H>`, `QueueMessageOutput<H>`, `QueueConsumerFor<H>`, `ResourceIdOf<H>`, `ResourceIds<R>`, `ResourceById<R, Id>` and `ResourceAliasesOfKind<R, Kind>`. See the [packages reference](../reference/packages.md#holqasdk).

## Handler modules

Business logic lives in handler modules, separate from `infra.ts`:

- A handler module registers a handler against a resource (for example `resources.orders.consume(...)`) and gives it its own stable `id`.
- Registration is declarative. It produces a descriptor whose JSON metadata (identifier, trigger, resource reference) is separate from the executable function, so tools can inspect it without running user code.
- Handlers import `infra.ts` for typed handles; `infra.ts` never imports handlers. This keeps declarations free of business logic and avoids cycles.
- Discovering handler modules through the `handlers` globs, checking handler identifiers for duplicates and executing handlers are **Planned**.

## Composable registries

Large applications do not need one enormous `infra.ts`. Resource groups declared with `defineResources` in separate modules are combined with `composeResources`, which rejects duplicate aliases, or with object spread. Identifiers remain unique across the whole application, and composition is deterministic. See [composing applications](composing-applications.md).

## Resource lifecycles

Persistent resources and handlers have **independent lifecycles**:

| Concern | Lifecycle |
| --- | --- |
| Persistent resource (queue, bucket) | Long-lived. Holds data that outlives any deployment. |
| Handler | Replaced on every deployment or reload. |
| Declaration in source | Edited freely by developers. |

Rules that follow from this:

1. **Deleting a declaration never implies destroying physical infrastructure.** Removing a `bucket` from `infra.ts` means the application no longer *uses* it. Destroying the bucket and its data requires a separate, explicit action through a provisioning provider, and tools must surface it as a destructive change. See [security](security.md).
2. Replacing a handler must not drop or reset the resource it consumes.
3. Queue messages and stored objects written by previous deployments may still exist after a schema change. Type correctness today does not imply compatibility with historical data; see [type safety and schemas](type-safety-and-schemas.md#compatibility-and-evolution).

## Related

- [Resource identity](resource-identity.md)
- [Composing applications](composing-applications.md)
- [Resource model architecture](../architecture/resource-model.md)
- [Resource graph](resource-graph.md)
- [Triggers and execution](triggers-and-execution.md)
- [Infrastructure providers](infrastructure-providers.md)
- [ADR 0003: Explicit resource declarations](../architecture/decisions/0003-explicit-resource-declarations.md)
- [ADR 0004: Stable logical resource identities](../architecture/decisions/0004-stable-logical-resource-identities.md)
