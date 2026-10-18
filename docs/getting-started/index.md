# Getting started

> **Status:** There is no installable Holqa release. This page explains how to explore the repository today and previews the intended application layout.

## What you can do today

Holqa is at the bootstrap stage. Inside this repository you can declare an application with `@holqa/sdk` and compile it into a manifest, but you cannot yet run its handlers locally, bundle it, or deploy it. The `@holqa/*` packages are marked `"private": true` and are not published to npm.

You can:

1. **Read the design.** Start with the [vision](../concepts/vision.md), then the [application model](../concepts/application-model.md) and [resource graph](../concepts/resource-graph.md).
2. **Build and test the repository.** The foundational packages build, typecheck, lint, and test.
3. **Run the CLI.** The `holqa` binary prints help and version information, inspects an application and writes its manifest (`holqa inspect`, `holqa build --manifest`), and reports structured diagnostics for commands that do not exist yet. [`examples/manifest`](../../examples/manifest/README.md) compiles real applications this way.
4. **Contribute.** See [development setup](../contributing/development.md) and [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Exploring the repository

Prerequisites (full details in [development setup](../contributing/development.md)):

| Tool | Version |
| --- | --- |
| Node.js | ≥ 22.13 (CI uses the version in `.node-version`) |
| pnpm | 12.14.0, pinned via `packageManager` (use pnpm ≥ 11, Corepack, or `npx pnpm@12.14.0`) |
| Bun | 1.3.13, pinned in `.bun-version` |

pnpm is the only package manager for this repository. Bun is used as a runtime and test runner, never to install dependencies.

```bash
git clone https://github.com/SrKleRAimBot/holqa.git
cd holqa
pnpm install
pnpm check
```

`pnpm check` runs every quality gate: build, typecheck, lint, tests, the agent instruction drift check, and the package boundary check.

### Trying the CLI

After `pnpm build`, run the built binary with Bun:

```bash
bun packages/cli/dist/bin.js --help
bun packages/cli/dist/bin.js --version
bun packages/cli/dist/bin.js dev --json
```

The last command exits with code `1` and prints a `HOLQA_CLI_NOT_IMPLEMENTED` diagnostic as JSON, because `holqa dev` is a proposed command. See the [CLI reference](../reference/cli.md).

### Using the core primitives

The implemented APIs are small. For example, `parseResourceId` validates a logical resource identifier:

```ts
import { formatDiagnostic, parseResourceId } from "@holqa/core";

const result = parseResourceId("order-processing");
if (result.ok)
  console.log(result.value);
else
  console.error(formatDiagnostic(result.error));
```

This only works inside the monorepo workspace (for example in a new package or example that depends on `@holqa/core` via `workspace:*`). See the [packages reference](../reference/packages.md).

## Preview: a future Holqa application

> **Illustrative only.** This section describes the intended developer experience. `defineApp`, the resource factories and typed handles exist in the private `@holqa/sdk` package, but HTTP routes, running handlers, local emulation and an installable release do not, and the code below is not type-checked against the SDK. Names and shapes may change.

### Intended layout

```text
my-app/
├── infra.ts                       # Application infrastructure registry
├── src/
│   ├── api/
│   │   └── orders.handler.ts      # HTTP/RPC handlers
│   ├── orders/
│   │   └── process.handler.ts     # Queue consumer
│   └── maintenance/
│       └── cleanup.handler.ts     # Scheduled task
└── web/                           # Static frontend (for example a Vite app)
```

### `infra.ts`

`infra.ts` declares logical resources with stable identifiers and schemas. It contains no business logic and performs no provisioning.

```ts
// Illustrative, proposed API.
import { bucket, defineApp, http, queue, schedule, secret } from "@holqa/sdk";
import { z } from "zod";

const app = defineApp({
  name: "commerce",
  handlers: ["./src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "public-api", basePath: "/api" }),
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
    DATABASE_URL: secret(z.string().min(1))
  }
});

export default app;
export const resources = app.resources;
```

### A queue consumer

The consumer reuses the queue's schema. No parallel message interface is written by hand.

```ts
// Illustrative, proposed API: src/orders/process.handler.ts
import { resources } from "../../infra";

export default resources.orders.consume({
  id: "orders.process",
  handler: async ({ message, delivery }) => {
    // message is inferred as { orderId: string; priority: "normal" | "urgent" }
    console.log(message.orderId, delivery.attempt);
  }
});
```

### Sending a message

```ts
// Illustrative, proposed API.
import { resources } from "../../infra";

await resources.orders.send({ orderId: "order_123", priority: "urgent" });
```

### Intended workflow

```bash
# Implemented.
holqa inspect --json      # print the resources, handlers, graph and manifest
holqa build --manifest    # write manifest.json and entrypoints.json

# Proposed commands. None of these are implemented.
holqa dev                 # run locally with emulated queue, storage, and scheduler
holqa queue send ...      # send a test message to the local queue
holqa build               # bundle runtime artifacts
```

`holqa inspect` and `holqa build --manifest` run the application's code; see the [CLI reference](../reference/cli.md).

## Next steps

- [Roadmap](../roadmap.md): what is built and what comes next.
- [Triggers and execution](../concepts/triggers-and-execution.md): how handlers are meant to run.
- [Architecture overview](../architecture/overview.md): how the packages fit together.
- [`examples/`](../../examples/README.md): the package smoke test and illustrative application examples.
