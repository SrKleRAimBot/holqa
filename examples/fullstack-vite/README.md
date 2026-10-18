# Full-stack Vite (illustrative)

> **Status:** Illustrative — uses the proposed Holqa API and planned integrations, none of which are implemented yet. Nothing here is type-checked or executed.

A Vite single-page app that calls typed RPC procedures. It shows the intended split between server code (procedures that may read secrets) and browser code (a generated client that contains only contracts and transport).

## Structure

```text
fullstack-vite/
├── infra.ts                          # http.api with RPC, staticSite for the Vite app, a secret
├── src/
│   └── api/
│       ├── list-orders.handler.ts    # RPC query: orders.list
│       └── create-order.handler.ts   # RPC mutation: orders.create (idempotent)
└── web/
    └── src/
        └── orders.ts                 # TanStack Query options from the generated client
```

The Vite configuration, components and router are omitted; TanStack Router (or any router) keeps owning frontend routing.

## What each file demonstrates

| File | Demonstrates |
| --- | --- |
| `infra.ts` | An `http.api` with an RPC path and a `staticSite` with a build command and SPA fallback. |
| `src/api/list-orders.handler.ts` | A query procedure with input and output schemas. The output schema lists only public fields, so internal columns never reach the client contract. |
| `src/api/create-order.handler.ts` | A mutation that takes a client-supplied idempotency key, so a retried request does not create a duplicate order. |
| `web/src/orders.ts` | Browser code that imports a client from the compiler's planned client generation (`web/src/generated/`, not present) and a planned TanStack Query integration. It never imports `infra.ts` or handler modules. |

## Browser-safety rules shown here

- The frontend imports only the generated client, never `infra.ts`, `src/**` or anything that reads `config`.
- The generated client is planned to contain procedure IDs, schemas and transport code only; handlers and secrets are excluded by construction.
- Inputs are validated again on the server, because client-side types are not a security boundary.

Package names such as `@holqa/tanstack-query` are placeholders; final npm names for integrations are not decided.
