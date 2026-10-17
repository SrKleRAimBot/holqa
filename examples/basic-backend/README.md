# Basic backend (illustrative)

> **Status:** Illustrative — uses the proposed Holqa API, which is not implemented yet. Nothing here is type-checked or executed, and the API may change.

A small order-processing backend that shows the intended shape of a Holqa application: one `infra.ts` that declares every resource with a stable ID, and handler modules that contain the business logic.

## Structure

```text
basic-backend/
├── infra.ts                                # Resource graph: API, queue, bucket, schedule, env
└── src/
    ├── db.ts                               # Application-owned database client (not a Holqa API)
    ├── orders/
    │   ├── create-order.handler.ts         # POST /api/orders → sends to the queue
    │   └── process-order.handler.ts        # Idempotent queue consumer
    ├── uploads/
    │   └── on-upload.handler.ts            # Object-created storage event
    └── maintenance/
        └── daily-cleanup.handler.ts        # Cron schedule handler
```

## What each file demonstrates

| File | Demonstrates |
| --- | --- |
| `infra.ts` | `defineApp` with `http.api`, `queue`, `bucket`, `schedule`, `secret` and `variable`. Each resource has an explicit `id` (for example `order-processing`) that is its persistent identity, independent of the property name. The queue declares its message schema, `schemaVersion`, retry limit and dead-letter handling. |
| `src/db.ts` | Holqa does not replace your database client. The connection string arrives as a validated secret from `config`, read lazily on first use: handler modules are evaluated by the compiler without configuration, so they must not read it at module top level. |
| `src/orders/create-order.handler.ts` | A typed HTTP route. The request body is validated at the trust boundary before the handler runs, and `resources.orders.send(...)` infers the message type from the queue schema in `infra.ts`. |
| `src/orders/process-order.handler.ts` | `resources.orders.consume(...)`: the single competing consumer for the queue. Delivery is at-least-once, so the handler records processed order IDs in the same transaction as its side effect. |
| `src/uploads/on-upload.handler.ts` | A storage event handler restricted to a key prefix. Object metadata comes from an untrusted upload and is checked before use; an upsert keeps repeated events harmless. |
| `src/maintenance/daily-cleanup.handler.ts` | A schedule handler that derives its cutoff from the scheduled time, so delayed or manually triggered runs remove the same rows. |

Handler-registration method names (`route`, `consume`, `onObjectCreated`, `handle`) and context fields (`delivery`, `log`, `scheduledTime`, `reply`) are placeholders for the proposed API, not settled names.

## Intended local workflow (proposed, not implemented)

```sh
holqa dev                          # run HTTP, queue, storage and scheduler emulation locally
holqa queue send order-processing '{"orderId":"…","priority":"urgent"}'
holqa cron run daily-cleanup
holqa inspect --json               # print the resource graph
```

Today the `holqa` CLI only supports `--help`, `--version` and `--json`; these commands report `HOLQA_CLI_NOT_IMPLEMENTED`.
