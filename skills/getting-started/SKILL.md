---
name: getting-started
description: Sets up the structure of a new Holqa application — an infra.ts resource registry plus *.handler.ts modules — and explains what can and cannot be run today. Use when starting a Holqa project, adding Holqa to an existing TypeScript backend, or orienting yourself in an unfamiliar Holqa codebase.
license: Apache-2.0
metadata:
  status: preview
---

# Getting started with a Holqa project

> **Preview — not yet available.** Holqa packages are not published to npm. The SDK (`@holqa/sdk`) exists in the Holqa repository and can declare applications, resources and handlers; `@holqa/runtime-bun` (also unpublished) serves HTTP routes and RPC procedures, while queue, storage and schedule delivery are not implemented. Of the CLI commands in this skill, only `holqa inspect` and `holqa build --manifest` are implemented; the others are **proposed**. Treat every code sample as illustrative; names may change.

## When to use

- Creating a new application that will use Holqa resources (APIs, queues, buckets, schedules).
- Explaining the expected layout of a Holqa project to a teammate or another agent.
- Checking what Holqa can actually do before planning work around it.

## Works today

From a checkout of the Holqa repository (`pnpm install && pnpm build`):

```sh
bun packages/cli/dist/bin.js --help        # lists options, implemented and proposed commands
bun packages/cli/dist/bin.js --version --json
bun packages/cli/dist/bin.js dev --json    # exits 1, HOLQA_CLI_NOT_IMPLEMENTED on stderr
```

Inside the Holqa repository, `@holqa/sdk` type-checks and validates declarations such as the `infra.ts` below (without `staticSite`, which is proposed). `holqa inspect --app infra.ts` prints its resources and handlers, and `holqa build --manifest` writes its manifest; both run the application's modules. Inside the repository, `createRuntime(await loadCompiledApplication({ root }))` and `serve(runtime)` from `@holqa/runtime-bun` serve the compiled routes and procedures (see `examples/http-api`). Nothing else in this skill runs yet. Do not try to install `@holqa/sdk` from npm; it is not published.

## Planned workflow

1. **Create the registry.** Add `infra.ts` at the project root. It is the single place where resources are declared.
2. **Declare resources with explicit IDs.** Each resource gets a stable `id` (for example `order-processing`). The property name is only a local handle. See the `define-resources` skill.
3. **Point to handler modules.** Set `handlers` to a glob such as `./src/**/*.handler.ts`. Business logic lives there, never in `infra.ts`.
4. **Export typed handles.** Export `resources` and `config` so handlers can import them and get inferred types.
5. **Write one handler per file.** Each file default-exports a registration such as `resources.orders.consume({...})`.
6. **Inspect the graph** with `holqa inspect --json` (implemented) and **run locally** with `holqa dev` (proposed).

```ts
// infra.ts — illustrative, proposed API
import { defineApp, http, queue, secret } from "@holqa/sdk";
import { z } from "zod";

const app = defineApp({
  name: "commerce",
  handlers: ["./src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "public-api", basePath: "/api" }),
    orders: queue({
      id: "order-processing",
      message: z.object({ orderId: z.string() }),
      schemaVersion: 1
    })
  },
  env: { DATABASE_URL: secret(z.string().min(1)) }
});

export default app;
export const resources = app.resources;
export const config = app.env;
```

Suggested layout:

```text
infra.ts
src/
  orders/create-order.handler.ts
  orders/process-order.handler.ts
web/                     # optional static frontend (Vite)
```

## Pitfalls

- **Treating declarations as provisioning calls.** `infra.ts` describes requirements; it must be deterministic and free of side effects (no network calls, no reading the clock, no random IDs).
- **Unstable IDs.** Changing a resource `id` means a different resource. Choose IDs once.
- **Implicit deletion.** Removing a declaration must never be treated as permission to delete physical infrastructure.
- **Secrets in the frontend.** Code under `web/` must not import `infra.ts` or anything that reads `config`.
- **Assuming exactly-once delivery.** Queues, storage events and schedules are at-least-once; handlers must be idempotent.

## Verification checklist

- [ ] `infra.ts` exists, exports `default`, `resources` and `config`, and has no side effects.
- [ ] Every resource has an explicit `id` matching `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$` (at most 63 characters).
- [ ] Handlers live in `*.handler.ts` files matched by the `handlers` glob.
- [ ] No frontend file imports `infra.ts` or a handler module.
- [ ] You have not claimed that `holqa dev` or the SDK works; status is stated as proposed.
