# Holqa documentation

Holqa is an open-source, TypeScript-native, infrastructure-agnostic application infrastructure framework. It aims to let developers declare an application's infrastructure (HTTP APIs, RPC procedures, queues, object storage, schedules, configuration) and its event-driven handlers through one strongly typed programming model, without coupling business logic to a particular infrastructure provider.

The central abstraction is the **application resource graph**: a declarative description of an application's logical resources, their contracts, and the handlers that consume or interact with them. A compiler turns that graph into a deterministic, infrastructure-neutral manifest; runtime drivers and providers bind it to a local environment or real infrastructure.

## Project status

> **Holqa is at the bootstrap stage. There is no installable release, and the framework described in these documents does not exist yet.**

What exists today:

- A pnpm + Turborepo monorepo with strict TypeScript, ESLint, Bun tests, and enforced package boundaries.
- `@holqa/core`: `Result`, structured `Diagnostic` values, a diagnostic code registry, and validated `ResourceId`s.
- `@holqa/compiler`: deterministic canonical JSON serialization, the foundation for the future manifest.
- `@holqa/cli`: a `holqa` binary that prints help and version information and reports structured diagnostics (with `--json`) for commands that are not implemented.

Disposable prototypes from the [M0 milestone](milestones/m0/index.md) live in [`experiments/`](../experiments/README.md); they are not part of the framework.

Everything else (the SDK, compiler pipeline, runtime, local development environment, clients, integrations, and providers) is **Accepted design**, **Proposed**, or **Planned**. The [status model](architecture/status-model.md) defines these terms; the [roadmap](roadmap.md) shows the order of work.

## Where to start

| If you want to… | Read |
| --- | --- |
| Understand what Holqa is for | [Vision](concepts/vision.md) |
| See what is built and what comes next | [Roadmap](roadmap.md) |
| Try the repository or contribute | [Getting started](getting-started/index.md), [Development setup](contributing/development.md) |
| Understand the architecture | [Architecture overview](architecture/overview.md) |
| Look up a package, CLI flag, or diagnostic code | [Reference](#reference) |

## Concepts

| Document | Summary |
| --- | --- |
| [Vision](concepts/vision.md) | Purpose, goals, non-goals, and design philosophy. |
| [Application model](concepts/application-model.md) | `defineApp`, `infra.ts`, logical resources, typed handles, resource lifecycles. |
| [Resource graph](concepts/resource-graph.md) | How resources, triggers, handlers, and dependencies form one model. |
| [Type safety and schemas](concepts/type-safety-and-schemas.md) | Source-based inference, Standard Schema, runtime validation, compatibility. |
| [Triggers and execution](concepts/triggers-and-execution.md) | HTTP, RPC, queues, storage events, schedules, and the Bun execution model. |
| [Infrastructure providers](concepts/infrastructure-providers.md) | Contracts, runtime drivers, provisioning providers, capability negotiation. |
| [Local development](concepts/local-development.md) | The planned Bun-based local environment and emulators. |
| [Agent-native development](concepts/agent-native-development.md) | Structured output, stable diagnostics, skills, and safe automation. |
| [Security](concepts/security.md) | Trust boundaries, secrets, safe infrastructure changes, build-time execution. |

## Architecture

| Document | Summary |
| --- | --- |
| [Overview](architecture/overview.md) | Layers and how packages map to them. |
| [Package boundaries](architecture/package-boundaries.md) | Package responsibilities, allowed dependency directions, enforcement. |
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
| [CLI](reference/cli.md) | Implemented flags, exit codes, JSON output, and proposed commands. |
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
