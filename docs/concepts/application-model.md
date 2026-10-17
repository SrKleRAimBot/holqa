# Application model

> **Status:** Accepted design — not implemented. Only resource identifier validation (`parseResourceId` in `@holqa/core`) is **Implemented**. All code below that uses `@holqa/sdk` is illustrative; the API is proposed and may change.

A Holqa application is a set of **logical resources** declared in a registry file, plus **handler modules** that contain business logic. This document describes the registry (`infra.ts` and `defineApp`), how resources are identified, how typed handles work, and how resource lifecycles relate to code.

## `infra.ts`: the application registry

Every Holqa application has a conventional entry point named `infra.ts`. It is the canonical registry of the application's infrastructure:

- It declares resources and configuration.
- It declares where handler modules live.
- It exports typed resource handles for use by handlers.
- It contains **no business logic** and performs **no provisioning**.

The following code is illustrative. The API is proposed, not implemented, and may change.

```ts
import { bucket, defineApp, http, queue, schedule, secret, staticSite, variable } from "@holqa/sdk";
import { z } from "zod";

const app = defineApp({
  name: "commerce",
  handlers: ["./src/**/*.handler.ts"],
  resources: {
    api: http.api({
      id: "public-api",
      basePath: "/api",
      rpc: { path: "/rpc" },
      docs: { title: "Commerce API", version: "1.0.0" }
    }),
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
    cleanup: schedule({ id: "daily-cleanup", cron: "0 2 * * *", timezone: "UTC", overlap: "skip" }),
    web: staticSite({
      id: "web",
      root: "./web",
      build: { command: "bun run build", output: "dist" },
      spaFallback: true
    })
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

## `defineApp`

`defineApp` (proposed) takes a single declaration object and returns an application definition. Its responsibilities:

| Field | Purpose |
| --- | --- |
| `name` | The application's name. |
| `handlers` | Glob patterns for handler modules. The compiler discovers handlers from these patterns ([compiler](../architecture/compiler.md)). |
| `resources` | A record of logical resource declarations. Property names are local aliases; `id` is the identity. |
| `env` | Typed configuration: `secret(...)` for sensitive values, `variable(...)` for non-sensitive ones, each with a schema. |

The returned object exposes `resources` (typed handles) and `env` (typed configuration accessors). `defineApp` must be **pure**: calling it twice with the same input yields equivalent definitions, it performs no I/O, and it does not read the clock, randomness, or environment variables. These constraints make declarations safe for the compiler to analyze and for development tooling to reload ([ADR 0003](../architecture/decisions/0003-explicit-resource-declarations.md)).

## Logical resources

A logical resource describes **what** the application needs and **which guarantees** it requires, not how a provider implements it. A queue declaration states its message schema, schema version, retry limit, and dead-letter requirement. It does not name a cloud queue service or carry provider configuration.

Initial resource kinds (all proposed):

| Kind | Declares |
| --- | --- |
| `http.api` | Base path, optional RPC mount, documentation metadata. |
| `queue` | Message schema, schema version, delivery policy (attempts, backoff, dead-letter). |
| `bucket` | Access policy. |
| `schedule` | Cron expression, timezone, overlap policy. |
| `staticSite` | Source root, build command and output, SPA fallback. |
| `secret` / `variable` | Configuration value schema, default (variables only). |

Future kinds (topics, WebSocket endpoints, workflows) are listed in [triggers and execution](triggers-and-execution.md).

How a logical resource becomes real infrastructure is the job of a binding; see [infrastructure providers](infrastructure-providers.md) and [ADR 0005](../architecture/decisions/0005-infrastructure-independent-resource-contracts.md).

## Stable identifiers

Every resource and every handler has an explicit, stable identifier. The TypeScript property name (`orders`) is a local alias for convenience; the identifier (`order-processing`) is the persistent identity used in manifests, bindings, and deployed infrastructure ([ADR 0004](../architecture/decisions/0004-stable-logical-resource-identities.md)).

Consequences:

- Renaming `orders` to `orderQueue` in TypeScript changes nothing about infrastructure.
- Changing `id: "order-processing"` is a deliberate identity change and must be treated as such by tooling.
- Identifiers must be unique within an application. Duplicates are a compiler error (planned).

**Implemented:** `@holqa/core` validates identifiers with `parseResourceId`. The current grammar is lowercase alphanumeric segments separated by single `-` or `.`, starting with a letter, at most 63 characters (`^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`). Examples: `order-processing`, `orders.process`. Invalid input yields a `HOLQA_RESOURCE_ID_INVALID` diagnostic. The grammar is an initial proposal and may be revised before 1.0.

## Typed handles

Each declared resource exposes a typed handle through `app.resources`. Handle types are inferred from the declaration, so producers and consumers share one schema without a hand-written interface.

The following code is illustrative. The API is proposed, not implemented, and may change.

```ts
// Producer
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

Handles are **operations** on a resource, not the resource itself. At runtime a handle delegates to whichever runtime driver is bound in the current environment (local emulator, test harness, or production driver). Handler code never imports a provider SDK to talk to a Holqa resource. See [type safety and schemas](type-safety-and-schemas.md) for how inference and validation interact.

## Handler modules

Business logic lives in handler modules, separate from `infra.ts`:

- A handler module registers a handler against a resource (for example `resources.orders.consume(...)`) and gives it its own stable `id`.
- The compiler discovers handler modules via the `handlers` globs.
- Handlers import `infra.ts` for typed handles; `infra.ts` never imports handlers. This keeps declarations free of business logic and avoids cycles.

## Composable registries

Large applications should not need one enormous `infra.ts`. Resource registries are designed to be composable from multiple files, for example a module per bounded context that exports a group of resource declarations, combined in `infra.ts`. The exact composition API is **Proposed**. Whatever form it takes, identifiers remain globally unique within the application and composition must remain deterministic.

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

- [Resource graph](resource-graph.md)
- [Triggers and execution](triggers-and-execution.md)
- [Infrastructure providers](infrastructure-providers.md)
- [ADR 0003: Explicit resource declarations](../architecture/decisions/0003-explicit-resource-declarations.md)
- [ADR 0004: Stable logical resource identities](../architecture/decisions/0004-stable-logical-resource-identities.md)
