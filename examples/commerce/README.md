# Commerce (reference application)

> **Status:** Reference example, type-checked and tested against the disposable M0 experiment packages. This example imports the prototype `@holqa/experiment-sdk`, not `@holqa/sdk`: it uses HTTP routes and the M0 runtime, which the real packages do not implement yet. It will be migrated when they do ([backlog](../../docs/milestones/m0/backlog.md) HB-26).

A small storefront backend used as Holqa's recurring development reference. Each milestone should be able to run, compile and test this application. It exercises every initial trigger type: HTTP routes, two queues with dead-lettering, an object storage event, and a cron schedule, plus secrets and variables.

## Structure

```text
commerce/
├── infra.ts                                   # Resource graph and configuration
├── src/
│   ├── contracts/                             # Message schemas, imported by infra.ts through an index
│   ├── store.ts                               # Application-owned persistence (in memory; not a Holqa API)
│   ├── catalog/list-products.handler.ts       # GET  /api/products
│   ├── orders/place-order.handler.ts          # POST /api/orders           -> order-fulfillment queue
│   ├── orders/get-order.handler.ts            # GET  /api/orders/:orderId
│   ├── orders/fulfil-order.handler.ts         # order-fulfillment consumer -> invoices bucket
│   ├── payments/payment-webhook.handler.ts    # POST /api/webhooks/payments -> payment-events queue
│   ├── payments/apply-payment.handler.ts      # payment-events consumer (idempotent by event id)
│   ├── invoices/invoice-created.handler.ts    # object-created under invoices/
│   └── maintenance/reconcile.handler.ts       # nightly-reconciliation schedule
└── tests/                                     # Compiles and runs the application with the experiments
```

## What it demonstrates

| Concern | Where |
| --- | --- |
| Schemas declared once and imported by `infra.ts` (brands, transforms, defaults) | `src/contracts/orders.ts` |
| Producer input types and consumer output types (`placedAt` is a string on send and a `Date` in the consumer) | `place-order` and `fulfil-order` handlers |
| Path parameters validated as UUIDs; status-specific responses built with `reply` | `get-order` handler |
| Untrusted payloads verified (HMAC with Web Crypto) and validated before use | `payment-webhook` handler |
| Idempotent consumers under at-least-once delivery; throwing to request redelivery | `apply-payment` handler |
| Configuration read inside handlers, never at module top level | `payment-webhook` handler |
| Handlers deriving their work from the scheduled time, not the clock | `reconcile` handler |

`src/store.ts` keeps state in module memory so the example runs without infrastructure. That state is reset on every reload, which is why production handlers must not rely on in-memory state.

## Running

```sh
pnpm turbo run typecheck test --filter=@holqa/example-commerce
```

`holqa dev` and the other workflow commands are proposed and not implemented; today the `holqa` CLI reports `HOLQA_CLI_NOT_IMPLEMENTED` for them.
