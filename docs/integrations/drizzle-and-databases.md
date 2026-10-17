# Drizzle and databases

> **Status:** Planned. No database integration exists. All code on this page is illustrative; the API is proposed and may change.

Holqa will **not** create a proprietary SQL abstraction or ORM. Data access belongs to established libraries such as Drizzle, Prisma, and native PostgreSQL clients. Holqa's role is narrower: model the database as an external dependency in the resource graph and supply its configuration safely.

## What Holqa provides

| Concern | Holqa's role |
| --- | --- |
| Connection configuration | Typed, validated secrets (for example `DATABASE_URL`) bound per environment. |
| Dependency visibility | The resource graph records which handlers use which external database (Proposed). |
| Local development | Configuration for a local database; Holqa does not emulate SQL. |
| Data access | None. Use Drizzle, Prisma, or a native client directly. |

## Usage pattern

```ts
// infra.ts (illustrative)
import { defineApp, secret } from "@holqa/sdk";
import { z } from "zod";

const app = defineApp({
  name: "commerce",
  resources: { /* ... */ },
  env: {
    DATABASE_URL: secret(z.string().url())
  }
});

export const config = app.env;
```

```ts
// src/db.ts (illustrative)
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../infra";

export const db = drizzle(config.DATABASE_URL);
```

Handlers import `db` and use Drizzle normally. Holqa does not wrap or proxy queries.

Whether external databases become an explicit resource kind (for example `database.external({ id: "main-db" })`) so that they appear in the manifest and can participate in capability checks is **Proposed**.

## Database-related features Holqa does not promise

| Feature | Position |
| --- | --- |
| Automatic reactive queries (Convex-style) | Not promised. Requires change-tracking infrastructure Holqa does not have. Reactive queries are a Future item on the [roadmap](../roadmap.md). |
| Database change events | Future. Depends on provider capabilities such as logical replication. |
| Schema migrations | Use the data library's migration tooling (for example Drizzle Kit). |
| Provisioning databases | Out of scope for the initial phases. |

## Transactions and queues

A common pattern is to write to the database and enqueue a message in the same handler. Holqa queues and an external database cannot share a transaction, so a crash between the two can lose or duplicate work. Applications should use idempotent consumers ([at-least-once delivery](../concepts/triggers-and-execution.md#at-least-once-delivery-and-idempotency)) and, where needed, an outbox pattern. Holqa may document or support such patterns later; it does not hide the problem.

## Related

- [Integrations](index.md)
- [Security: secret handling](../concepts/security.md#secret-handling)
- [Triggers and execution](../concepts/triggers-and-execution.md)
