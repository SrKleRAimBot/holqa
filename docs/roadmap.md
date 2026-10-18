# Roadmap

> **Status:** Phase 0 to phase 3 are in progress. Later phases are **Planned**. This roadmap has no dates; phases are ordered by dependency, not by calendar.

This roadmap distinguishes the current bootstrap state from future implementation work. Status terms follow the [status model](architecture/status-model.md). Each phase lists its goals and the exit criteria that must hold before the phase is considered complete. Later phases may start before earlier ones finish when the dependency allows it.

## Overview

| Phase | Name | Status |
| --- | --- | --- |
| 0 | Bootstrap | In progress |
| M0 | Foundation and architecture validation | Complete (see [M0](milestones/m0/index.md)) |
| 1 | Core resource model and SDK | In progress |
| 2 | Compiler | In progress (manifest, discovery, validation, `inspect` and `build --manifest` **Implemented**) |
| 3 | Bun runtime and local development | In progress (dispatcher, lifecycle, HTTP routes, RPC procedures, queue, storage and schedule delivery and `@holqa/local` drivers **Implemented**) |
| 4 | Clients and integrations | Planned |
| 5 | Providers and bindings | Planned |
| Future | Extended triggers and tooling | Planned |

```mermaid
flowchart LR
  P0[Phase 0: Bootstrap] --> P1[Phase 1: Resource model and SDK]
  P1 --> P2[Phase 2: Compiler]
  P1 --> P3[Phase 3: Bun runtime and local dev]
  P2 --> P3
  P2 --> P4[Phase 4: Clients and integrations]
  P3 --> P5[Phase 5: Providers and bindings]
  P4 --> P5
```

## Phase 0: Bootstrap

**Goal:** A trustworthy, well-documented, agent-ready repository foundation. No framework functionality.

### Done

| Item | Status |
| --- | --- |
| pnpm 12 workspace with catalogs and a committed `pnpm-lock.yaml` | **Implemented** |
| Turborepo task graph (`build`, `typecheck`, `lint`, `test`, `dev`, `clean`, and root gates), with `pnpm check` as the single quality gate | **Implemented** |
| Strict shared TypeScript configuration (TypeScript 6, see [ADR 0010](architecture/decisions/0010-typescript-6-until-tooling-supports-7.md)) | **Implemented** |
| Shared ESLint flat config based on `@antfu/eslint-config`, including JSDoc summary enforcement and architectural import restrictions | **Implemented** |
| tsdown builds producing ESM `.js` and bundled `.d.ts`, with `@/` aliases resolved ([ADR 0011](architecture/decisions/0011-path-aliases-in-library-packages.md)) | **Implemented** |
| Bun test runner with tests under `tests/` mirroring `src/` ([ADR 0009](architecture/decisions/0009-test-placement-and-typescript-standards.md)) | **Implemented** |
| Package boundary checks (`scripts/check-boundaries.ts`) | **Implemented** |
| Agent instructions, rules, and skills with sync and drift check (`pnpm agents:sync`, `pnpm agents:check`) | **Implemented** |
| `@holqa/core` primitives: `Result`, `Diagnostic`, diagnostic code registry, `ResourceId` | **Implemented** |
| `@holqa/compiler` canonical JSON serialization | **Implemented** |
| `@holqa/cli` help, version, `--json`, and structured "not implemented" diagnostics | **Implemented** |
| `examples/package-smoke` verifying built package outputs | **Implemented** |
| Architecture documentation and ADRs 0001–0011 | **Implemented** (as documents) |
| GitHub Actions CI workflow (`.github/workflows/ci.yml`) and Changesets configuration (publishing disabled) | **Implemented** (configured) |

### Remaining exit criteria

- CI is confirmed passing on pull requests in the hosted repository.
- Automated publishing stays disabled until release ownership and credentials are configured.
- Repository owner confirms the license (Apache-2.0) before any public release.
- Documentation has no broken relative links.

## M0: Foundation and architecture validation

**Goal:** Confirm that the scaffold's checks, package boundaries, toolchain and proposed APIs work together, and find fundamental limitations of the programming model before the SDK accumulates code.

Outcome: the baseline passes, the package layers are confirmed and extended ([ADR 0017](architecture/decisions/0017-package-layers-after-m0.md)), and four disposable experiments under [`experiments/`](../experiments/README.md) recorded their results. ADRs 0012–0017 record the decisions, and the [backlog](milestones/m0/backlog.md) lists the follow-up work with dependencies and acceptance criteria. Nothing from M0 is a framework capability: the experiments are **not** Implemented framework features.

## Phase 1: Core resource model and SDK

**Goal:** Developers can declare an application's resources in `infra.ts` with full type inference, even though nothing executes yet.

### Done

| Item | Status |
| --- | --- |
| Logical resource model in `@holqa/core`: descriptor protocol, typed resource and trigger kind registries, capability requirements, handler metadata separated from `invoke`, runtime binding contract ([resource model](architecture/resource-model.md), ADRs 0018 to 0020) | **Implemented** |
| `defineApp`, `defineResources`, `composeResources`, `queue`, `bucket`, `schedule`, `http.api`, `secret`, `variable` as pure declarations with declaration-time validation | **Implemented** |
| Typed handles inferred from declarations, across modules, with no generated code | **Implemented** |
| Handler registration for queues, buckets and schedules | **Implemented** |
| HTTP routes with `reply`, RPC procedures, typed middleware and `scoped` values ([runtime reference](reference/runtime.md)) | **Implemented** |
| Composition of resource registries from multiple files ([composing applications](concepts/composing-applications.md)) | **Implemented** |
| Type-level tests, including negative tests, for every implemented resource kind; `@holqa/testing` type assertions | **Implemented** |
| Schema system: structured validation errors, JSON wire payloads validated after encoding, versioned message envelopes, the `SchemaAdapter` contract, normalization into canonical contracts, fingerprints and a compatibility checker ([schema contracts](reference/schema-contracts.md), [ADR 0021](architecture/decisions/0021-schema-contracts-wire-payloads-and-compatibility.md)) | **Implemented** |
| The first schema adapter: `@holqa/zod` for Zod 4 | **Implemented** |

### Remaining goals

- Implement the remaining factories: `staticSite`.
- Extend the `ResourceId` grammar decision ([ADR 0004](architecture/decisions/0004-stable-logical-resource-identities.md)) and finalize it before 1.0.

### Exit criteria

- Type-level tests (including negative tests with `@ts-expect-error`) prove inference for every resource kind.
- Declarations are plain data plus schemas; constructing them has no side effects.
- Unsupported schemas produce an explicit diagnostic such as `HOLQA_SCHEMA_UNSUPPORTED`.
- `@holqa/sdk` obeys its boundaries: no imports of compiler, runtime, Bun, or Node modules.

## Phase 2: Compiler

**Goal:** Turn an application's declarations and handlers into a deterministic, versioned, infrastructure-neutral manifest with structured diagnostics. See [compiler architecture](architecture/compiler.md).

### Done

| Item | Status |
| --- | --- |
| Versioned manifest (version 1) and entry point map with published JSON Schemas, TypeScript types and validating readers ([compiler specification](reference/compiler-specification.md), [ADR 0022](architecture/decisions/0022-manifest-v1-and-entry-point-map.md)) | **Implemented** |
| Application loading (`infra.ts`) and handler discovery with the glob patterns declared in `defineApp`, evaluated in a separate process with an allowlisted environment | **Implemented** |
| Static validation: duplicate resource and handler identifiers, references to undeclared resources, trigger kind mismatches, one consumer per queue, conflicting routes, unknown settings, invalid schemas | **Implemented** |
| Schema contracts (fingerprint, source, `schemaVersion`) recorded in the manifest's schema table | **Implemented** |
| Resource graph builder (`buildResourceGraph`) and required capabilities | **Implemented** |
| `holqa inspect` (text and `--json`) and `holqa build --manifest` | **Implemented** |
| Byte-identical manifests across processes, working directories and application locations, verified by [`examples/manifest`](../examples/manifest/README.md) | **Implemented** |

### Remaining goals

- Compare the manifest with a previously deployed manifest using the **Implemented** compatibility checker.
- Bundle executable artifacts from the entry point map (`holqa build` without `--manifest`).
- Check required capabilities against a selected binding at build time.
- Harden analysis with a real sandbox (restricted file system and network) when one is practical on Bun.

### Exit criteria

- The same inputs produce byte-identical manifests across runs and machines. **Met** for runs, working directories and application locations on one machine; cross-machine runs are covered by the same guarantees but not yet by CI on several platforms.
- Every compiler failure is a `Diagnostic` with a registered `HOLQA_*` code and, where possible, a source location. **Met.**
- `holqa inspect --json` returns the resource graph as stable JSON. **Met.**
- Compilation and bundling are separate steps with separate outputs ([ADR 0007](architecture/decisions/0007-separate-compiler-and-runtime.md)). **Met** for the manifest; bundling is not implemented.

## Phase 3: Bun runtime and local development

**Goal:** Run a Holqa application locally on Bun without cloud credentials. See [local development](concepts/local-development.md) and [triggers and execution](concepts/triggers-and-execution.md).

### Done

| Item | Status |
| --- | --- |
| `@holqa/runtime-bun`: one invocation dispatcher (identifiers, time limits, cancellation, bounded concurrency, error normalization, structured logs) and the application lifecycle (start, graceful stop, application-scoped values) ([runtime reference](reference/runtime.md), [ADR 0023](architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md)) | **Implemented** |
| HTTP routing on the Fetch API, request validation, typed responses, CORS and streaming; RPC procedures (`holqa.rpc/1`) on the same HTTP runtime | **Implemented** |
| Typed middleware at application, API and route scope | **Implemented** |
| Loading `holqa build --manifest` output and serving it with `Bun.serve`, verified by [`examples/http-api`](../examples/http-api/README.md) | **Implemented** |
| Queue, object event and schedule transports on the dispatcher: leased at-least-once delivery, retries with declared backoff, dead-lettering, bounded consumer concurrency, overlap policies, graceful shutdown ([runtime reference](reference/runtime.md), [ADR 0024](architecture/decisions/0024-event-delivery-sources-and-local-drivers.md)) | **Implemented** |
| `@holqa/local`: SQLite-backed queues and event state, filesystem object storage with events and development signed URLs, a scheduler driven by an injectable clock, inspection and failure simulation ([local environment](reference/local.md)) | **Implemented** |
| An event-driven application running end to end locally (HTTP upload, object event, queue consumer with retries and dead-lettering, scheduled cleanup), verified by [`examples/document-processing`](../examples/document-processing/README.md) | **Implemented** |

### Goals

- `@holqa/runtime-bun`: worker or process isolation.
- `holqa dev` with fast backend reloads and structured logs.
- `holqa invoke`, `holqa queue send`, `holqa storage put`, `holqa cron run` for manual triggering.
- `@holqa/testing`: deterministic integration testing helpers on top of `@holqa/local` (the local environment already simulates duplicate delivery, retries and failures).

### Exit criteria

- An example application runs end to end locally with HTTP, a queue consumer, and a schedule. **Met** by `examples/document-processing`.
- Local emulators document their delivery and concurrency semantics and do not promise stronger guarantees than production drivers are expected to offer. **Met** for `@holqa/local` ([local environment](reference/local.md)).
- Runtime validation runs at every trust boundary (incoming HTTP, queue messages, storage events). **Met**.

## Phase 4: Clients and integrations

**Goal:** Holqa composes with the TypeScript ecosystem instead of replacing it. See [integrations](integrations/index.md).

### Goals

- `@holqa/client`: framework-independent, browser-safe generated client runtime over the Fetch API.
- OpenAPI generation for HTTP APIs (`holqa openapi generate`).
- TanStack Query integration: typed query and mutation options and query keys.
- oRPC and Hono interoperability.
- Vite integration for single-origin development and static builds.
- Valibot and Effect Schema adapters; Effect handler adapter.

### Exit criteria

- Generated clients contain no handler code, internal functions, credentials, or secrets, verified by tests.
- Each integration lives in its own package under `packages/integrations/` and depends only on `@holqa/core`, `@holqa/sdk`, or `@holqa/client`.
- Final npm names for integration packages are decided.

## Phase 5: Providers and bindings

**Goal:** Bind the infrastructure-neutral manifest to real infrastructure. See [infrastructure providers](concepts/infrastructure-providers.md).

### Goals

- Define the provisioning provider contract. The runtime driver and delivery source contracts exist in `@holqa/core` (**Implemented**, implemented locally by `@holqa/local`); drivers for external services are Planned.
- Capability negotiation: bindings declare capabilities; the compiler rejects unsupported semantics explicitly.
- Environment-specific bindings.
- One or two initial runtime drivers (for example an S3-compatible storage driver and a self-hostable queue) chosen to validate the abstraction, not to favor a vendor.
- A first provisioning provider that produces a reviewable plan and never deletes physical infrastructure implicitly.
- `holqa doctor` for binding and environment validation.

### Exit criteria

- A binding that cannot satisfy a declared requirement fails with a diagnostic; nothing is silently downgraded.
- Runtime drivers operate with least-privilege credentials that do not include provisioning permissions.
- Destructive infrastructure changes require explicit confirmation.

## Future

These capabilities have extension points in the design but no committed phase. All are **Planned**.

| Capability | Notes |
| --- | --- |
| Event topics and fan-out | Independent subscriptions; distinct from single-consumer queues. |
| WebSocket handlers | Built on the HTTP execution model. |
| Durable workflows | Requires durable state and replay semantics. |
| Reactive queries | Requires underlying change-tracking infrastructure; no promise of automatic database reactivity. |
| Database change events | Depends on provider capabilities. |
| External event integrations | Third-party event sources. |
| OpenTelemetry integration | Traces and metrics for handlers. |
| TanStack Start integration | Full-stack hosting integration. |
| Local MCP server | Exposes the resource graph, diagnostics, and local invocations to agents. See [agent-native development](concepts/agent-native-development.md). |
| Schema migration engine | Upgrades data written under an older `schemaVersion`. The compatibility checker and the version metadata it needs are **Implemented**. |
