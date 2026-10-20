---
name: holqa-architecture
description: Orientation to Holqa's architecture for contributors - the application resource graph, the separation of resource definitions, handlers, and infrastructure bindings, the package map and allowed dependency directions, compiler versus runtime responsibilities, runtime drivers versus provisioning providers and capability validation, and the Implemented/Accepted design/Proposed/Planned status model. Use before any architectural change, when adding or moving a package or module, when deciding where new code belongs, or when unsure whether a capability already exists.
---

# Holqa architecture

## Purpose

Holqa is an open-source, TypeScript-native, infrastructure-agnostic application infrastructure framework. It is at the **bootstrap stage**: almost all of the architecture is design, not code. This skill helps you place work correctly and avoid describing or building against things that do not exist.

## When to use

- Before changing package responsibilities, dependency directions, or public contracts.
- When deciding which package a new module belongs in.
- When a task mentions resources, handlers, providers, the compiler, the runtime, or the manifest.
- When unsure whether something is implemented.

## Step 0: read the docs first

Before any architectural change, read in this order and cite what you relied on:

1. [docs/architecture/status-model.md](../../../docs/architecture/status-model.md): what is Implemented today.
2. [docs/architecture/overview.md](../../../docs/architecture/overview.md) and [package-boundaries.md](../../../docs/architecture/package-boundaries.md).
3. The concept doc for the area ([resource-graph](../../../docs/concepts/resource-graph.md), [infrastructure-providers](../../../docs/concepts/infrastructure-providers.md), [triggers-and-execution](../../../docs/concepts/triggers-and-execution.md), [type-safety-and-schemas](../../../docs/concepts/type-safety-and-schemas.md), [security](../../../docs/concepts/security.md)).
4. Relevant ADRs in [docs/architecture/decisions/](../../../docs/architecture/decisions/README.md).

If your change contradicts an accepted ADR, stop and propose a new ADR instead of silently diverging.

## Core model (Accepted design, not implemented)

An application declares a **resource graph**: logical resources (HTTP APIs, RPC procedures, queues, buckets, schedules, static sites, secrets, variables, external connections), their contracts, and the handlers that interact with them. A conventional `infra.ts` is the registry (illustrative; proposed API).

Three concerns stay separate:

| Concern | Answers | Example (illustrative) |
| --- | --- | --- |
| Resource definitions | What exists and what guarantees it needs | `queue({ id: "order-processing", message: schema, delivery: { maxAttempts: 5 } })` |
| Operations and handlers | How application code uses resources and reacts to events | `resources.orders.consume({ id: "orders.process", handler })` |
| Infrastructure bindings | How a provider or local runtime fulfills the requirements | a local queue emulator or a message broker binding |

Invariants to preserve in every design:

- Resources have explicit, stable IDs (`ResourceId`), independent of TypeScript property names.
- Declarations are declarative and deterministic; no provisioning side effects at definition time.
- Deleting a declaration never authorizes deleting physical infrastructure.
- Types are inferred from source; runtime validation is mandatory at trust boundaries.
- Unsupported capabilities fail explicitly; nothing is silently downgraded.

## Package map

| Package | Responsibility | Status | May depend on |
| --- | --- | --- | --- |
| `@holqa/core` | Neutral contracts: `Result`, `Diagnostic`, `diagnosticCodes`, `ResourceId`, `HolqaError`, descriptor protocol with resource/trigger kind registries, `RuntimeBinding` | **Implemented** (contracts) | none |
| `@holqa/compiler` | Canonical JSON, schema contracts, `compileApplication` (handler discovery, graph validation, event dependency graph and cycle analysis), manifest version 1, entry point map; client generation and bundling later | **Implemented** (manifest pipeline) | core |
| `@holqa/cli` | `holqa` bin: `--help`, `--version`, `--json`, `inspect`, `build --manifest` (analysis in a separate Bun process), `dev` (supervisor with process generations), `invoke`, `queue send`, `queue redrive`, `storage put`, `cron run`, `state`, `doctor`, `inspect --cycles`, telemetry commands (`logs`, `traces list`, `traces inspect`, `events inspect`, `metrics`); `openapi generate` reports `HOLQA_CLI_NOT_IMPLEMENTED` | **Implemented** (all but `openapi generate` and bundling) | core, compiler, local, runtime-bun, opentelemetry |
| `@holqa/sdk` | Public developer SDK (`defineApp`, `queue`/`bucket`/`schedule`/`http.api`, typed handles, handler registration) | **Implemented** (including HTTP routes, RPC procedures, middleware) | core |
| `@holqa/client` | Browser-safe generated-client runtime | Planned | core |
| `@holqa/runtime-bun` | Invocation dispatcher, lifecycle, HTTP, RPC, queue, object event and schedule transports, event lineage and limits, telemetry (spans, metrics, redaction, bounded export), `Bun.serve` adapter ([runtime reference](../../../docs/reference/runtime.md)) | **Implemented** (worker isolation planned) | core |
| `@holqa/bindings` | Binding configurations (`defineBindings`), deterministic provider resolution per resource, kind and service, composition into one runtime binding ([binding contracts](../../../docs/reference/bindings.md)) | **Implemented** | core |
| `@holqa/local` | Local drivers and sources: SQLite-backed queues, filesystem object storage, clock-driven scheduler, inspection, local telemetry store ([local environment](../../../docs/reference/local.md)) | **Implemented** | core, runtime-bun |
| `@holqa/testing` | Test utilities: `createTestApp` (virtual clock, flushing, failure injection, duplicates) and type assertions | **Implemented** | core, sdk, local, runtime-bun |
| `packages/integrations/*` | Zod, OpenTelemetry (OTLP export), Valibot, Effect, oRPC, TanStack Query adapters | **Implemented** for Zod (`@holqa/zod`) and OTLP export (`@holqa/opentelemetry`); others Planned (names undecided) | core, sdk, client |

Planned packages are directories with a README only. Enforcement: `scripts/check-boundaries.ts` (`pnpm boundaries:check`) and `no-restricted-imports` in `eslint.config.mjs`. `core`, `compiler`, `sdk`, `client` never import `bun`, `bun:*`, `node:*`; `sdk`/`client` never import compiler, runtime, local, cli, or testing.

### Where does new code go?

- A contract, type, or diagnostic every layer needs → `core` (must stay runtime-neutral and dependency-free).
- Analysis, normalization, manifest construction, deterministic serialization → `compiler`.
- Anything that executes handlers or uses Bun APIs → `runtime-bun` or `cli`. Request validation and middleware composition belong in the SDK's registration `invoke`; routing, limits, lifecycle and error responses in `runtime-bun` ([ADR 0023](../../../docs/architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md)).
- Emulation of queues/storage/schedules → `local`.
- Developer-facing builders and typed handles → `sdk`. A new resource or trigger kind starts in `core`'s `ResourceKindMap`/`TriggerKindMap` (see `docs/architecture/resource-model.md`).
- Framework-specific glue → `packages/integrations/<name>` (planned).

Creating a planned package is an architectural change: it needs a `package.json`, real tests, an `allowedDependencies` entry, docs updates, and usually an ADR.

## Compiler vs. runtime (ADR 0007)

The compiler turns declarations and handlers into a deterministic, versioned, infrastructure-neutral **manifest**, executable artifacts, generated clients, and structured diagnostics. The runtime executes handlers against bindings. They share contracts through `core` only. Compilation and bundling are separate concerns. Today the manifest (version 1), its JSON Schema and the entry point map exist ([compiler specification](../../../docs/reference/compiler-specification.md)); bundling and client generation do not.

The compiler must never evaluate user configuration unsandboxed while claiming the evaluation is secure. The CLI evaluates application modules in a separate Bun process with an allowlisted environment; that process is **not** a sandbox (it can still use the file system and network).

## Providers and capabilities (ADR 0005)

- **Runtime driver**: performs operations (send, get, put) at run time. Must not need provisioning permissions.
- **Provisioning provider** (optional): creates and reconciles physical infrastructure.
- Bindings declare capabilities; the logical resource declares requirements; mismatches produce diagnostics.
- No provider-specific configuration bags in the core resource model. No provider is implemented.

## Status model

Use exactly **Implemented**, **Accepted design**, **Proposed**, **Planned**. Promoting something to Implemented requires code, tests, and doc updates (status model table, reference pages, roadmap) in the same change. When unsure, choose the weaker status.

## Verification checklist

- [ ] I read the status model, the relevant concept doc, and related ADRs before changing architecture.
- [ ] New code lives in the package whose responsibility matches, and dependency directions are respected.
- [ ] No provider-specific types or configuration entered neutral packages.
- [ ] No unimplemented capability is described or exported as working.
- [ ] Architectural decisions are recorded as a new or superseding ADR.
- [ ] `pnpm boundaries:check` and `pnpm check` pass, and I reported the real results.

## References

- Local: [docs/architecture/overview.md](../../../docs/architecture/overview.md), [docs/architecture/compiler.md](../../../docs/architecture/compiler.md), [docs/architecture/package-boundaries.md](../../../docs/architecture/package-boundaries.md), [docs/architecture/status-model.md](../../../docs/architecture/status-model.md), [docs/concepts/application-model.md](../../../docs/concepts/application-model.md), [docs/roadmap.md](../../../docs/roadmap.md), ADRs [0003](../../../docs/architecture/decisions/0003-explicit-resource-declarations.md), [0004](../../../docs/architecture/decisions/0004-stable-logical-resource-identities.md), [0005](../../../docs/architecture/decisions/0005-infrastructure-independent-resource-contracts.md), [0007](../../../docs/architecture/decisions/0007-separate-compiler-and-runtime.md)
- Related skills: `resource-contracts`, `framework-integration`, `safe-refactoring`, `security-boundaries`
