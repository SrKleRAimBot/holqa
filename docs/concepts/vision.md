# Vision

> **Status:** Accepted design — not implemented. This document describes intent, not shipped functionality.

## Purpose

Holqa is an open-source, TypeScript-native, infrastructure-agnostic application infrastructure framework.

Modern TypeScript backends combine many kinds of infrastructure: an HTTP API, RPC procedures for a frontend, queues and background consumers, object storage with event handlers, scheduled jobs, configuration and secrets, a static frontend, and connections to external databases. Today these are usually wired together with a different SDK, configuration format, and local-development story for each piece. Message types are duplicated between producers and consumers, frontend clients drift from backend contracts, and business logic ends up coupled to a specific cloud vendor's APIs.

Holqa's purpose is to let developers declare that infrastructure and the event-driven behavior around it through **one strongly typed programming model**, while keeping business logic independent of any particular infrastructure provider.

## The central abstraction

Holqa's central abstraction is the **application resource graph**: an application declares its logical resources, their contracts, and the handlers that consume or interact with them. Everything else (type inference, local emulation, client generation, manifests, provider bindings) is derived from that graph. See [resource graph](resource-graph.md) and [application model](application-model.md).

## Goals

| Goal | What it means |
| --- | --- |
| Explicit, declarative infrastructure | Resources are declared as data in `infra.ts`, with stable identifiers, not created by imperative provisioning calls ([ADR 0003](../architecture/decisions/0003-explicit-resource-declarations.md)). |
| End-to-end type inference | Handler and client types are inferred from the declarations, not maintained in parallel. |
| Portable schema contracts and runtime validation | Schemas are expressed through Standard Schema and normalized into a portable representation; data is validated at trust boundaries ([ADR 0006](../architecture/decisions/0006-standard-schema-and-portable-schema-representation.md)). |
| Event-driven functions | HTTP, RPC, queues, storage events, and schedules share one handler model. |
| A unified, typed resource graph | One model connects resources, triggers, handlers, and dependencies. |
| Extensible providers and runtime drivers | Logical requirements are fulfilled by interchangeable bindings ([ADR 0005](../architecture/decisions/0005-infrastructure-independent-resource-contracts.md)). |
| Bun-based execution | Bun is the primary runtime ([ADR 0002](../architecture/decisions/0002-bun-as-primary-runtime.md)). |
| Excellent local development and deterministic testing | Applications run locally without cloud credentials and can be tested deterministically. |
| Ecosystem integration | Holqa works with Zod, Effect, oRPC, Hono, Vite, TanStack, Drizzle, and similar tools instead of replacing them. |
| Reproducible compilation | The compiler produces deterministic, versioned, infrastructure-neutral manifests ([ADR 0007](../architecture/decisions/0007-separate-compiler-and-runtime.md)). |
| Agent-native tooling | Structured JSON output, stable diagnostic codes, and maintained agent skills ([agent-native development](agent-native-development.md)). |

## Non-goals

Holqa is deliberately **not**:

| Not… | Because |
| --- | --- |
| Another HTTP framework | HTTP is one trigger type. Holqa should interoperate with Hono, oRPC, and the Fetch API rather than compete with them. |
| Another ORM | Data access belongs to Drizzle, Prisma, and native database clients. Holqa will not build a proprietary SQL layer. |
| A general-purpose cloud SDK | Holqa models the resources an application needs, not every API a provider offers. |
| A replacement for Terraform or Pulumi | Holqa describes logical application requirements. Provisioning providers may delegate to existing infrastructure tools. |
| A proprietary RPC protocol | RPC is a specialization of HTTP, and existing RPC libraries remain usable. |
| A new JavaScript runtime | Holqa runs on Bun; it does not fork or replace it. |

Holqa is also not tied to a hosting environment. It must be useful when developers manage their own infrastructure, reuse existing infrastructure, or choose third-party providers.

## Philosophy

### Declarations are data

A resource declaration describes *what* is needed and *which guarantees* it requires. It does not perform side effects. This makes declarations analyzable by a compiler, inspectable by tools and agents, and safe to load repeatedly in development.

### Identity is explicit and stable

A resource's persistent identity is an explicit identifier such as `order-processing`, not a TypeScript property name. Renaming a variable must never imply replacing infrastructure ([ADR 0004](../architecture/decisions/0004-stable-logical-resource-identities.md)).

### Types come from source

Application-internal types are inferred directly from source declarations. Code generation is reserved for consumers that cannot import the source, such as browser clients and external API consumers. See [type safety and schemas](type-safety-and-schemas.md).

### Portability without pretending

Provider independence does not mean every provider offers identical guarantees. Logical resources declare required behavior; a binding either proves it satisfies those requirements or fails explicitly. Holqa never silently downgrades semantics. See [infrastructure providers](infrastructure-providers.md).

### Explicit over magic

Holqa prefers explicit contracts over uncontrolled reflection, structured diagnostics over thrown strings, and visible failures over silent fallbacks. Every diagnostic carries a stable `HOLQA_*` code ([diagnostic codes](../reference/diagnostic-codes.md)).

### Safe by default

Deleting a declaration does not authorize deleting physical infrastructure. Generated clients never contain secrets or private handlers. Runtime drivers do not need provisioning permissions. See [security](security.md).

### Honest status

Documentation distinguishes Implemented, Accepted design, Proposed, and Planned work ([status model](../architecture/status-model.md)). A smaller, honest, working foundation is preferred over an impressive but fictional one.

## Relationship to existing frameworks

Holqa sits *around* application frameworks rather than replacing them. A Hono app or oRPC router could serve as the implementation of a Holqa HTTP resource; a Vite frontend could be served as a Holqa static site; Drizzle continues to own database access. Holqa's contribution is the resource graph that ties these together with shared types, local emulation, and a portable manifest. See [integrations](../integrations/index.md).

## Related

- [Application model](application-model.md)
- [Resource graph](resource-graph.md)
- [Roadmap](../roadmap.md)
- [Architecture overview](../architecture/overview.md)
