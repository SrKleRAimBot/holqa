# Holqa documentation

Holqa is an open-source, TypeScript-native, infrastructure-agnostic application infrastructure framework. It aims to let developers declare an application's infrastructure (HTTP APIs, RPC procedures, queues, object storage, schedules, configuration) and its event-driven handlers through one strongly typed programming model, without coupling business logic to a particular infrastructure provider.

The central abstraction is the **application resource graph**: a declarative description of an application's logical resources, their contracts, and the handlers that consume or interact with them. A compiler turns that graph into a deterministic, infrastructure-neutral manifest; runtime drivers and providers bind it to a local environment or real infrastructure.

## Project status

> **Holqa is at an early stage. There is no installable release, and most of the framework described in these documents does not exist yet.**

What exists today:

- A pnpm + Turborepo monorepo with strict TypeScript, ESLint, Bun tests, and enforced package boundaries.
- `@holqa/core`: `Result`, structured `Diagnostic` values, a diagnostic code registry, validated `ResourceId`s, and the descriptor protocol and runtime binding contract behind the resource model.
- `@holqa/sdk`: `defineApp`, resource declarations (`queue`, `bucket`, `schedule`, `http.api`), configuration (`secret`, `variable`), typed resource handles inferred from source, handlers for queues, buckets (object created and deleted) and schedules, queue sends with delays, object operations with bounded listings and signed URLs, and HTTP routes, RPC procedures and typed middleware.
- `@holqa/testing`: compile-time type assertions and `createTestApp` for deterministic integration tests (virtual clock, event flushing, failure injection, duplicate delivery, a simulation budget, publication chain inspection, in-memory telemetry, and recording, replay and causal chain stepping).
- `@holqa/compiler`: deterministic canonical JSON, schema contracts, compilation of an application into a validated resource graph and a deterministic manifest (version 1) with an entry point map, and an event dependency graph with cycle detection. See the [compiler specification](reference/compiler-specification.md) and [event safety](concepts/event-safety.md).
- `@holqa/runtime-bun`: an invocation dispatcher with lifecycle, limits, cancellation and structured logs that executes compiled applications' HTTP routes and RPC procedures on Bun, and delivers queue messages, object events and scheduled runs with retries, backoff, dead-lettering, event lineage, depth and budget limits and graceful shutdown; it records traces and metrics on the OpenTelemetry model and redacts secrets from logs and telemetry; a versioned handler registry replaces handler implementations while in-flight invocations finish on the old ones. See the [runtime reference](reference/runtime.md) and [observability](concepts/observability.md).
- `@holqa/opentelemetry`: an OTLP/HTTP JSON exporter for traces, metrics and logs, and the standard `OTEL_*` variables.
- `@holqa/local`: a local binding with SQLite-backed queues, filesystem object storage with events and development signed URLs, and a clock-driven scheduler, plus inspection and a local telemetry store. See the [local environment reference](reference/local.md).
- `@holqa/cli`: a `holqa` binary that prints help and version information, inspects an application and its event cycles (`holqa inspect`, `--cycles`), writes its manifest (`holqa build --manifest`), runs it locally with hot handler replacement, reloads and a local development dashboard (`holqa dev`), invokes handlers and sends events (`holqa invoke`, `queue send`, `storage put`, `cron run`), redrives dead letters (`holqa queue redrive`), prints local state (`holqa state`), checks the project (`holqa doctor`), prints logs, traces, event histories and metrics of local runs (`holqa logs`, `traces list`, `traces inspect`, `events inspect`, `metrics`), and reports structured diagnostics (with `--json`). See the [local development guide](guides/local-development.md).

Disposable prototypes from the [M0 milestone](milestones/m0/index.md) live in [`experiments/`](../experiments/README.md); they are not part of the framework.

Everything else (`holqa openapi generate`, module unloading, worker isolation, bundling, client generation, clients, integrations other than Zod and OTLP export, a graphical trace timeline view, and providers for external services) is **Accepted design**, **Proposed**, or **Planned**. The [status model](architecture/status-model.md) defines these terms; the [roadmap](roadmap.md) shows the order of work.

## Where to start

| If you want to… | Read |
| --- | --- |
| Understand what Holqa is for | [Vision](concepts/vision.md) |
| See what is built and what comes next | [Roadmap](roadmap.md) |
| Try the repository or contribute | [Getting started](getting-started/index.md), [Development setup](contributing/development.md) |
| Run, debug and test an application locally | [Local development guide](guides/local-development.md) |
| Find event cycles and bound event-driven work | [Event safety guide](guides/event-safety.md) |
| Read logs, traces and metrics, or export them to an OTLP backend | [Observability guide](guides/observability.md) |
| Understand the architecture | [Architecture overview](architecture/overview.md) |
| Look up a package, CLI flag, or diagnostic code | [Reference](#reference) |

## Concepts

| Document | Summary |
| --- | --- |
| [Vision](concepts/vision.md) | Purpose, goals, non-goals, and design philosophy. |
| [Application model](concepts/application-model.md) | `defineApp`, `infra.ts`, logical resources, typed handles, resource lifecycles. |
| [Resource identity](concepts/resource-identity.md) | Identifier rules, aliases versus identities, compile-time and run-time checks. |
| [Composing applications](concepts/composing-applications.md) | Splitting registries across modules, resource groups, cross-module types. |
| [Resource graph](concepts/resource-graph.md) | How resources, triggers, handlers, and dependencies form one model. |
| [Type safety and schemas](concepts/type-safety-and-schemas.md) | Source-based inference, Standard Schema, runtime validation, compatibility. |
| [Triggers and execution](concepts/triggers-and-execution.md) | HTTP, RPC, queues, storage events, schedules, and the Bun execution model. |
| [Event safety](concepts/event-safety.md) | Event cycle analysis, event lineage, runtime limits, idempotency and replay (**Implemented**). |
| [Observability](concepts/observability.md) | Structured logging, tracing, metrics, exporters and local execution history (**Implemented**; trace timeline view Planned). |
| [Infrastructure providers](concepts/infrastructure-providers.md) | Contracts, runtime drivers, provisioning providers, capability negotiation. |
| [Local development](concepts/local-development.md) | The local environment: `@holqa/local` drivers, `holqa dev`, reloads and `createTestApp` (**Implemented**). |
| [Agent-native development](concepts/agent-native-development.md) | Structured output, stable diagnostics, skills, and safe automation. |
| [Security](concepts/security.md) | Trust boundaries, secrets, safe infrastructure changes, build-time execution. |

## Architecture

| Document | Summary |
| --- | --- |
| [Overview](architecture/overview.md) | Layers and how packages map to them. |
| [Package boundaries](architecture/package-boundaries.md) | Package responsibilities, allowed dependency directions, enforcement. |
| [Resource model](architecture/resource-model.md) | Descriptors, kind registries, handler metadata, runtime binding, dependency architecture. |
| [Compiler](architecture/compiler.md) | Compilation pipeline, manifest principles, diagnostics. |
| [Status model](architecture/status-model.md) | The Implemented / Accepted design / Proposed / Planned vocabulary. |
| [Architecture decision records](architecture/decisions/README.md) | Index of ADRs and the [ADR template](architecture/decisions/template.md). |

### Architecture decision records

| ADR | Title |
| --- | --- |
| [0001](architecture/decisions/0001-monorepo-tooling-pnpm-turborepo.md) | Monorepo tooling with pnpm and Turborepo |
| [0002](architecture/decisions/0002-bun-as-primary-runtime.md) | Bun as the primary runtime |
| [0003](architecture/decisions/0003-explicit-resource-declarations.md) | Explicit resource declarations |
| [0004](architecture/decisions/0004-stable-logical-resource-identities.md) | Stable logical resource identities |
| [0005](architecture/decisions/0005-infrastructure-independent-resource-contracts.md) | Infrastructure-independent resource contracts |
| [0006](architecture/decisions/0006-standard-schema-and-portable-schema-representation.md) | Standard Schema and portable schema representation (superseded by 0016) |
| [0007](architecture/decisions/0007-separate-compiler-and-runtime.md) | Separate compiler and runtime |
| [0008](architecture/decisions/0008-agent-instructions-and-skills.md) | Agent instructions and skills |
| [0009](architecture/decisions/0009-test-placement-and-typescript-standards.md) | Test placement and TypeScript standards |
| [0010](architecture/decisions/0010-typescript-6-until-tooling-supports-7.md) | TypeScript 6 until tooling supports 7 |
| [0011](architecture/decisions/0011-path-aliases-in-library-packages.md) | Path aliases in library packages |
| [0012](architecture/decisions/0012-source-inferred-types-and-reply-helpers.md) | Source-inferred types and reply helpers |
| [0013](architecture/decisions/0013-descriptor-protocol-in-core.md) | A descriptor protocol in `@holqa/core` |
| [0014](architecture/decisions/0014-evaluation-based-manifest-extraction.md) | Evaluation-based manifest extraction |
| [0015](architecture/decisions/0015-runtime-generations-and-reload.md) | Runtime generations and reload |
| [0016](architecture/decisions/0016-schema-adapters-and-conversion-fidelity.md) | Schema adapters and conversion fidelity |
| [0017](architecture/decisions/0017-package-layers-after-m0.md) | Package layers after M0 |
| [0018](architecture/decisions/0018-typed-kind-registries-in-the-descriptor-protocol.md) | Typed kind registries in the descriptor protocol |
| [0019](architecture/decisions/0019-declaration-time-validation.md) | Declaration-time validation in the SDK |
| [0020](architecture/decisions/0020-runtime-binding-resolution.md) | Runtime binding resolution |
| [0021](architecture/decisions/0021-schema-contracts-wire-payloads-and-compatibility.md) | Schema contracts, wire payloads and compatibility |
| [0022](architecture/decisions/0022-manifest-v1-and-entry-point-map.md) | Manifest version 1 and a separate entry point map |
| [0023](architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md) | A common invocation engine, with HTTP and RPC as its first transports |
| [0024](architecture/decisions/0024-event-delivery-sources-and-local-drivers.md) | Event delivery through binding sources, with local drivers as the first binding |
| [0025](architecture/decisions/0025-dev-supervisor-and-process-generations.md) | A development supervisor with one process per generation |
| [0026](architecture/decisions/0026-event-safety-analysis-lineage-and-execution-guards.md) | Event safety: static cycle analysis, event lineage and execution guards |

## Milestones

| Document | Summary |
| --- | --- |
| [M0: foundation and architecture validation](milestones/m0/index.md) | Baseline report, experiment results, accepted decisions, and the backlog that follows. |

## Integrations

| Document | Summary |
| --- | --- |
| [Integrations overview](integrations/index.md) | Integration categories, status, and principles. |
| [Schema libraries](integrations/schema-libraries.md) | Zod, Valibot, and Effect Schema adapters. |
| [Effect](integrations/effect.md) | Effect handlers, Effect Schema, and Effect HTTP. |
| [oRPC and Hono](integrations/orpc-and-hono.md) | Reusing existing HTTP and RPC frameworks. |
| [TanStack](integrations/tanstack.md) | TanStack Query, Router, and Start. |
| [Vite](integrations/vite.md) | Frontend development and static builds. |
| [Drizzle and databases](integrations/drizzle-and-databases.md) | Data access without a proprietary SQL layer. |

## Reference

| Document | Summary |
| --- | --- |
| [Packages](reference/packages.md) | Every package, its status, purpose, and entry points. |
| [Diagnostic codes](reference/diagnostic-codes.md) | Implemented `HOLQA_*` codes and the stability policy. |
| [Schema contracts](reference/schema-contracts.md) | Validation errors, wire encoding, canonical contracts, fingerprints, compatibility policy and Zod support. |
| [CLI](reference/cli.md) | Implemented flags, exit codes, JSON output, and proposed commands. |
| [Runtime](reference/runtime.md) | Execution lifecycle, invocations, HTTP routes, middleware ordering and the `holqa.rpc/1` protocol. |
| [API design specification](reference/api-design.md) | Proposed public APIs for applications, resources, handlers, schema adapters and bindings. |

## Contributing

| Document | Summary |
| --- | --- |
| [Development setup](contributing/development.md) | Toolchain, commands, and the repository layout. |
| [Code style](contributing/code-style.md) | ESLint conventions, documentation comments, TypeScript rules. |
| [Testing](contributing/testing.md) | Test placement, Bun test runner, type-level tests. |
| [Releasing](contributing/releasing.md) | Changesets, SemVer, and package readiness. |
| [Agent instructions](contributing/agent-instructions.md) | `AGENTS.md`, `.agents/`, `.claude/`, and skills. |

The repository root also contains [`README.md`](../README.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`SECURITY.md`](../SECURITY.md), and [`AGENTS.md`](../AGENTS.md). Public agent skills for Holqa application developers live in [`skills/`](../skills/README.md); examples live in [`examples/`](../examples/README.md).
