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
| `@holqa/core` | `Result`, `ok`, `err`; `Diagnostic`, `createDiagnostic`, `formatDiagnostic`; the `diagnosticCodes` registry; `ResourceId`, `parseResourceId`, `isResourceId`, `maxResourceIdLength` |
| `@holqa/compiler` | `canonicalJsonStringify`, `CanonicalJsonError`, `CanonicalJsonValue` |
| `@holqa/cli` | `holqa --help`, `--version`, `--json`; structured errors for proposed and unknown commands |
| `examples/package-smoke` | Verification that built packages are consumable through their public exports |
| Repository tooling | pnpm workspace, Turborepo tasks, ESLint configuration, boundary checks, agent instruction sync |

See [packages reference](../reference/packages.md), [CLI reference](../reference/cli.md), and [diagnostic codes](../reference/diagnostic-codes.md) for details.

The disposable M0 prototypes under [`experiments/`](../../experiments/README.md) and the [`commerce` example](../../examples/commerce/README.md) built on them run and are tested, but they are **not** Implemented framework capabilities. They are evidence for Accepted design decisions (ADRs 0012–0017), and no framework API may be described as existing because an experiment exercises it.

## How documents use the labels

### Status line

Every concept and architecture document begins with a status line directly below the title:

```markdown
> **Status:** Accepted design — not implemented.
```

When a document mixes statuses (for example, the [compiler](compiler.md) document describes an implemented canonical JSON serializer and a planned pipeline), the status line summarizes the overall state and individual sections or table rows carry their own labels.

### Inline labels

Use the exact bold terms in tables and prose when the status of a specific item matters:

```markdown
| Capability | Status |
| --- | --- |
| Canonical JSON serialization | **Implemented** |
| Manifest schema | **Planned** |
```

### Illustrative code

Code that uses APIs which do not exist (for example `defineApp`, `queue(...)`, or `resources.orders.send(...)`) must be introduced as illustrative. Place a sentence such as the following immediately before the code block:

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
4. Proposed CLI commands must always be described as not implemented until they are. Today they exit with `HOLQA_CLI_NOT_IMPLEMENTED`.

## Related

- [Documentation home](../index.md)
- [Roadmap](../roadmap.md)
- [Architecture overview](overview.md)
- [ADR index](decisions/README.md)
