# Holqa

Holqa is an open-source, TypeScript-native framework for defining application infrastructure and event-driven backend
behavior through one strongly typed programming model, without coupling business logic to an infrastructure provider.

> [!IMPORTANT]
> **Holqa is in early development.** This repository currently contains the monorepo foundation, architecture
> documentation, the application and resource model (`@holqa/sdk`), a compiler that turns an application into a
> deterministic manifest (`holqa inspect`, `holqa build --manifest`), a Bun runtime for HTTP, RPC, queues, storage
> events and schedules, local drivers (`@holqa/local`), a local development supervisor with reloads (`holqa dev`),
> CLI commands to invoke handlers and send events, and `createTestApp` for deterministic integration tests. Providers
> for external infrastructure and generated clients are **design, not shipped software**. Nothing is published. See the
> [roadmap](docs/roadmap.md) for what exists today.

## The problem

A typical backend is more than request handlers. It has queues and their consumers, object storage and its events,
scheduled jobs, configuration and secrets, and a frontend that calls typed APIs. These pieces are usually wired
together with provider-specific SDKs, duplicated type definitions, and infrastructure code that lives apart from the
application. Changing providers, running everything locally, or letting an agent understand the whole system is hard.

## The idea: an application resource graph

Holqa's central abstraction is the **application resource graph**. An application declares its logical resources and
their contracts in an `infra.ts` file; handlers in separate modules respond to events from those resources. Holqa keeps
three concerns apart:

1. **Resource definitions** — what infrastructure exists and what guarantees it requires.
2. **Operations and handlers** — how application code uses resources and reacts to events.
3. **Infrastructure bindings** — how a provider or the local runtime fulfils those requirements.

The developer experience looks like this (**illustrative**: the declarations and handler registration use the implemented,
unpublished `@holqa/sdk`, but nothing runs handlers yet):

```ts
// infra.ts
import { defineApp, http, queue } from "@holqa/sdk";
import { z } from "zod";

const app = defineApp({
  name: "commerce",
  handlers: ["./src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "public-api", basePath: "/api" }),
    orders: queue({
      id: "order-processing",
      message: z.object({ orderId: z.string(), priority: z.enum(["normal", "urgent"]) }),
      schemaVersion: 1,
      delivery: { maxAttempts: 5, deadLetter: true }
    })
  }
});

export default app;
export const resources = app.resources;
```

```ts
// src/orders/process-order.handler.ts
import { resources } from "../../infra";

export default resources.orders.consume({
  id: "orders.process",
  handler: async ({ message, delivery }) => {
    // `message` is inferred from the queue's schema and validated at runtime.
    console.log(message.orderId, delivery.attempt);
  }
});
```

Types flow from the declaration to every producer and consumer without code generation, and runtime validation guards
every trust boundary. Read [the application model](docs/concepts/application-model.md) for details.

## Infrastructure-agnostic by design

Holqa is independent of any hosting provider. A logical resource states the behavior it needs (for example, a queue
with dead-lettering and five delivery attempts). A **runtime driver** performs operations against real infrastructure,
and an optional **provisioning provider** creates and reconciles it. Bindings must prove they satisfy a resource's
requirements: unsupported semantics fail explicitly instead of being silently ignored. A local provider is a first-class
target, so applications should run without cloud credentials. See [infrastructure providers](docs/concepts/infrastructure-providers.md).

## How Holqa relates to other tools

Holqa is not an HTTP framework, an ORM, a cloud SDK, a replacement for Terraform or Pulumi, or a new JavaScript runtime.
It is designed to compose with existing tools: Zod, Valibot and Effect Schema for schemas; Hono, oRPC and Effect for
transport and handlers; TanStack Query and Vite on the frontend; Drizzle or Prisma for data access. Bun is the primary
runtime. These integrations are planned; see [integrations](docs/integrations/index.md).

## What exists today

| Package | Path | Status |
| --- | --- | --- |
| `@holqa/core` | [packages/core](packages/core) | Implemented contracts: `Result`, structured diagnostics with stable `HOLQA_*` codes, resource identity, schema validation, the descriptor protocol and the runtime binding contract |
| `@holqa/sdk` | [packages/sdk](packages/sdk) | Implemented application and resource model: `defineApp`, queues, buckets, schedules, HTTP APIs with routes, RPC procedures and typed middleware, configuration, typed handles |
| `@holqa/compiler` | [packages/compiler](packages/compiler) | Implemented: handler discovery, graph validation, deterministic manifest version 1, schema contracts and compatibility checks |
| `@holqa/cli` | [packages/cli](packages/cli) | Implemented: `holqa --help`, `--version`, `--json`, `inspect` (with `--cycles`), `build --manifest`, `dev`, `invoke`, `queue send`, `queue redrive`, `storage put`, `cron run`, `state` and `doctor`; `openapi generate` is proposed |
| `@holqa/testing` | [packages/testing](packages/testing) | Implemented: `createTestApp` (virtual clock, event flushing, failure injection, duplicate delivery) and compile-time type assertions |
| `@holqa/zod` | [packages/integrations/zod](packages/integrations/zod) | Implemented: Zod 4 schema adapter |
| `@holqa/runtime-bun` | [packages/runtime-bun](packages/runtime-bun) | Implemented: invocation dispatcher, lifecycle, HTTP routes and RPC procedures served with `Bun.serve`, queue, object event and schedule delivery with retries and dead-lettering |
| `@holqa/local` | [packages/local](packages/local) | Implemented: local drivers — SQLite-backed queues, filesystem object storage with events and development signed URLs, a clock-driven scheduler, inspection |
| `@holqa/client`, other integrations | [packages](packages) | Planned (design documents only) |

All packages are private and unpublished. The full list is in [docs/reference/packages.md](docs/reference/packages.md).

## Repository structure

```text
packages/          Holqa libraries (core, sdk, compiler, cli, runtime-bun, local, and planned packages)
examples/          package-smoke, schema-evolution, manifest, http-api and document-processing (run in CI) and illustrative application examples
docs/              Concepts, architecture, ADRs, integrations, reference, contributing guides
skills/            Agent Skills for developers building with Holqa (preview)
.agents/           Canonical rules and skills for agents working on this repository
.claude/           Claude Code mirror of .agents/ plus Claude-only reviewer subagents
scripts/           Maintainer scripts (agent mirror sync, boundary checks)
tooling/           Shared TypeScript configuration for packages
```

## Development

Requirements: Node.js ≥ 22.13, pnpm 12.14.0 (pinned in `package.json`; use pnpm ≥ 11 or Corepack), and Bun 1.3.13.

```bash
pnpm install
pnpm check        # build, typecheck, lint, test, agent-mirror and boundary checks
```

Individual tasks: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:fix`, `pnpm test`. See
[docs/contributing/development.md](docs/contributing/development.md).

## Documentation

- [Documentation index](docs/index.md)
- [Vision and philosophy](docs/concepts/vision.md)
- [Architecture overview](docs/architecture/overview.md) and [decision records](docs/architecture/decisions/README.md)
- [Roadmap](docs/roadmap.md)

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). AI coding agents should follow
[AGENTS.md](AGENTS.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). The license choice is pending final confirmation by the repository owner before the first
public release.
