# Status model

> **Status:** Implemented — this vocabulary is in use across the documentation and ADRs.

Holqa is at the bootstrap stage. Most of its documentation describes a framework that does not exist yet. To keep the documentation trustworthy, every capability, design, and document carries one of four status labels. This page defines those labels and how to apply them.

## The four statuses

| Status | Meaning | Evidence required |
| --- | --- | --- |
| **Implemented** | The capability exists in this repository, is exported or runnable, and is covered by tests. | Source under `packages/*/src`, tests under `packages/*/tests`, passing `pnpm check`. |
| **Accepted design** | An agreed architectural direction. Contributors should build toward it, but no code exists yet. | An ADR with status `Accepted`, or a concept document that states the direction. |
| **Proposed** | Under consideration. The idea is plausible but needs validation (prototype, research, or discussion) before it is accepted. | A concept document, an ADR with status `Proposed`, or an issue. |
| **Planned** | On the [roadmap](../roadmap.md), but not designed in detail. | A roadmap entry. |

A capability moves through these states roughly in the order Planned → Proposed → Accepted design → Implemented, but not every item passes through every state. A small, uncontroversial utility can go straight to Implemented with tests.

## What is Implemented today

Only the following items carry the **Implemented** label. Everything else in the documentation is Accepted design, Proposed, or Planned.

| Package | Implemented items |
| --- | --- |
| `@holqa/core` | `Result`, `ok`, `err`; `Diagnostic`, `createDiagnostic`, `formatDiagnostic`; the `diagnosticCodes` registry; `ResourceId`, `parseResourceId`, `isResourceId`, `maxResourceIdLength`, `checkIdentities`; `HolqaError`; JSON and Standard Schema types, `validateInput` with structured issues; JSON wire payloads (`toWirePayload`, `prepareWirePayload`), message envelopes and codecs, payload codecs; the `SchemaAdapter` contract; the descriptor protocol with resource and trigger kind registries and readers; `RuntimeBinding` with drivers and delivery `sources`, `bindApp`, `resolveDriver`, `checkCapabilities`; the `bucket.object-deleted` trigger, the `holqa.object-event/1` envelope (`readObjectEvent`), `checkObjectKey`, queue backoff (`backoffDelaySeconds`), cron evaluation (`parseCronSchedule`, `nextCronTime`); the `http.procedure` trigger, `HttpInvocationInput`, `HttpRejectedError`, the `holqa.rpc/1` envelope types, `ApplicationScope` |
| `@holqa/sdk` | `defineApp`, `defineResources`, `composeResources`; `queue`, `bucket`, `schedule`, `http.api`; `secret`, `variable`; typed handles and handler registration for queues, buckets and schedules; queue `send` with delays and receipts; bucket `put`, `get`, `head`, `delete`, `list`, `signedUrl`, `onObjectCreated`, `onObjectDeleted`; HTTP routes (`route`, `reply`), RPC procedures (`procedure`), typed `middleware` and `scoped` values; compile-time identifier and duplicate checks |
| `@holqa/testing` | Compile-time type assertions (`Equal`, `Expect`, `Accepts`, `HasTypeError`, `assertType`, ...) |
| `@holqa/compiler` | `canonicalJsonStringify`, `CanonicalJsonError`, `CanonicalJsonValue`; schema normalization (`normalizeSchema`, `describeSchemaContract`, `canonicalizeJsonSchema`), `fingerprintSchemaContract`, `checkSchemaCompatibility`; `compileApplication` (handler discovery, graph validation, manifest version 1, entry point map), `selectHandlerModules`, `discoverHandlers`, `validateManifest`, `validateEntrypoints`, `buildResourceGraph`, the manifest and entry point JSON Schemas |
| `@holqa/runtime-bun` | `createRuntime` (invocation dispatcher, lifecycle, HTTP routing, RPC, CORS, structured logs, queue, object event and schedule delivery with retries, backoff and dead-lettering), `serve` and `stopOnSignals` (`Bun.serve`), `loadCompiledApplication`, `createEnvironmentBinding`. See the [runtime reference](../reference/runtime.md) |
| `@holqa/local` | `createLocalEnvironment` (SQLite-backed queues and event state, filesystem object storage with events and development signed URLs, a clock-driven scheduler, inspection), `ManualClock`, `systemClock`. See the [local environment reference](../reference/local.md) |
| `@holqa/zod` | The Zod 4 schema adapter (`zodAdapter`, `createZodAdapter`, `isZodSchema`) |
| `@holqa/cli` | `holqa --help`, `--version`, `--json`; `holqa inspect`; `holqa build --manifest`; analysis in a separate process (`createProcessHost`); structured errors for proposed and unknown commands |
| `examples/package-smoke` | Verification that built packages are consumable through their public exports |
| `examples/schema-evolution` | End-to-end schema contract corpus with Zod |
| `examples/manifest` | End-to-end compilation of SDK applications through the built CLI |
| `examples/http-api` | An SDK application compiled by the built CLI and served by `@holqa/runtime-bun` |
| `examples/document-processing` | An event-driven SDK application (uploads, object events, a queue consumer with retries and dead-lettering, a scheduled cleanup) compiled by the built CLI and run on `@holqa/local` |
| Repository tooling | pnpm workspace, Turborepo tasks, ESLint configuration, boundary checks, agent instruction sync |

See [packages reference](../reference/packages.md), [CLI reference](../reference/cli.md), [runtime reference](../reference/runtime.md), and [diagnostic codes](../reference/diagnostic-codes.md) for details.

The disposable M0 prototypes under [`experiments/`](../../experiments/README.md) and the [`commerce` example](../../examples/commerce/README.md) built on them run and are tested, but they are **not** Implemented framework capabilities. They are evidence for Accepted design decisions (ADRs 0012–0017), and no framework API may be described as existing because an experiment exercises it.

## How documents use the labels

### Status line

Every concept and architecture document begins with a status line directly below the title:

```markdown
> **Status:** Accepted design — not implemented.
```

When a document mixes statuses (for example, the [compiler](compiler.md) document describes an implemented manifest pipeline and planned client generation and bundling), the status line summarizes the overall state and individual sections or table rows carry their own labels.

### Inline labels

Use the exact bold terms in tables and prose when the status of a specific item matters:

```markdown
| Capability | Status |
| --- | --- |
| Canonical JSON serialization | **Implemented** |
| Client generation | **Planned** |
```

### Illustrative code

Code that uses APIs which do not exist (for example `staticSite(...)`, generated clients, or `holqa dev`) must be introduced as illustrative. Place a sentence such as the following immediately before the code block:

> The following code is illustrative. The API is proposed, not implemented, and may change.

Never present illustrative code as runnable, and never show output that was not produced by running real code.

## How ADRs use the labels

ADRs under [`decisions/`](decisions/README.md) have their own lifecycle field (`Proposed`, `Accepted`, `Superseded`, `Deprecated`). An ADR with status `Accepted` records an **Accepted design** decision; it does not mean the decision is implemented. Where an ADR's decision is partly implemented (for example, [ADR 0004](decisions/0004-stable-logical-resource-identities.md) and the implemented `parseResourceId`), the ADR states which part exists.

Use the [ADR template](decisions/template.md) for new decisions.

## Changing a status

- **Promoting to Implemented** requires code, tests, and documentation updates in the same change. Update this page's table, the relevant reference page, and the [roadmap](../roadmap.md).
- **Promoting to Accepted design** requires an ADR or an explicit decision recorded in a concept document.
- **Demoting or removing** a design is allowed and expected. Mark ADRs as `Superseded` rather than deleting them.

## Rules for contributors and agents

1. Do not describe an unimplemented capability in the present tense as if it works ("Holqa retries failed messages"). Write "Holqa is designed to retry…" or label the section.
2. Do not upgrade a status without the evidence listed above.
3. When unsure, choose the weaker status.
4. Proposed CLI commands must always be described as not implemented until they are. Today they exit with `HOLQA_CLI_NOT_IMPLEMENTED`. Only `holqa inspect` and `holqa build --manifest` are implemented workflow commands.

## Related

- [Documentation home](../index.md)
- [Roadmap](../roadmap.md)
- [Architecture overview](overview.md)
- [ADR index](decisions/README.md)
