# Architecture decision records

This directory holds Holqa's Architecture Decision Records (ADRs). An ADR records one significant decision: the context that forced it, what was decided, its consequences, and the alternatives that were rejected. ADRs are not specifications or tutorials. They explain why the repository and the framework design look the way they do.

An ADR documents a decision. It does not mean a capability exists. Several accepted ADRs describe design principles that are not built yet, and each of them says so. For what is actually built, see the [status model](../status-model.md) and the [package reference](../../reference/packages.md).

## Statuses

| Status | Meaning |
| --- | --- |
| **Proposed** | Under consideration. The direction is plausible but has to be validated through implementation before it is accepted. Code may explore it, but other decisions should not depend on it yet. |
| **Accepted** | Agreed by the maintainers. For repository and tooling decisions, this means the decision is in effect now. For architectural principles, the direction is binding for future work, and the ADR states whether it is implemented. |
| **Superseded** | Replaced by a later ADR. The superseding ADR is linked in the metadata, and the old record stays for history. |
| **Deprecated** | No longer applies and has not been replaced, for example because the area it covered was removed. |

Once an ADR is accepted, it is not rewritten. To change a decision, write a new ADR that supersedes it, then update the old ADR's `Status` line to `Superseded by [NNNN](NNNN-title.md)`. Typos, broken links and clarifications that do not change the decision can be edited in place.

## Index

| Number | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-monorepo-tooling-pnpm-turborepo.md) | Monorepo tooling: pnpm, Turborepo and Changesets | Accepted | 2026-10-17 |
| [0002](0002-bun-as-primary-runtime.md) | Bun as the primary runtime and test runner | Accepted | 2026-10-17 |
| [0003](0003-explicit-resource-declarations.md) | Explicit, declarative resource declarations | Accepted (not implemented) | 2026-10-17 |
| [0004](0004-stable-logical-resource-identities.md) | Stable logical resource identities | Accepted (identifier validation and declaration-time checks implemented) | 2026-10-17 |
| [0005](0005-infrastructure-independent-resource-contracts.md) | Infrastructure-independent resource contracts | Proposed | 2026-10-17 |
| [0006](0006-standard-schema-and-portable-schema-representation.md) | Standard Schema and a portable schema representation | Superseded by [0016](0016-schema-adapters-and-conversion-fidelity.md) | 2026-10-17 |
| [0007](0007-separate-compiler-and-runtime.md) | Separate compiler and runtime | Accepted (not implemented) | 2026-10-17 |
| [0008](0008-agent-instructions-and-skills.md) | Agent instructions and skill organization | Accepted | 2026-10-17 |
| [0009](0009-test-placement-and-typescript-standards.md) | Test placement and TypeScript standards | Accepted | 2026-10-17 |
| [0010](0010-typescript-6-until-tooling-supports-7.md) | TypeScript 6 until the toolchain supports TypeScript 7 | Accepted | 2026-10-17 |
| [0011](0011-path-aliases-in-library-packages.md) | `@/` path aliases in library packages | Accepted | 2026-10-17 |
| [0012](0012-source-inferred-types-and-reply-helpers.md) | Source-inferred types and reply helpers | Accepted (inference implemented; `reply` not implemented) | 2026-10-17 |
| [0013](0013-descriptor-protocol-in-core.md) | A descriptor protocol in `@holqa/core` | Accepted (implemented with the proposed layout of 0018) | 2026-10-17 |
| [0014](0014-evaluation-based-manifest-extraction.md) | Evaluation-based manifest extraction | Accepted (implemented; decision 4 refined by proposed 0022) | 2026-10-17 |
| [0015](0015-runtime-generations-and-reload.md) | Runtime generations and reload | Accepted (validated in M0; decision 7 would be superseded in part by proposed 0025) | 2026-10-17 |
| [0016](0016-schema-adapters-and-conversion-fidelity.md) | Schema adapters and conversion fidelity | Accepted (implemented for Zod; 0021 proposes refining decision 2) | 2026-10-17 |
| [0017](0017-package-layers-after-m0.md) | Package layers after M0 | Accepted (existing rows enforced) | 2026-10-17 |
| [0018](0018-typed-kind-registries-in-the-descriptor-protocol.md) | Typed kind registries in the descriptor protocol | Proposed (implemented) | 2026-10-17 |
| [0019](0019-declaration-time-validation.md) | Declaration-time validation in the SDK | Proposed (implemented) | 2026-10-17 |
| [0020](0020-runtime-binding-resolution.md) | Runtime binding resolution | Proposed (implemented) | 2026-10-17 |
| [0021](0021-schema-contracts-wire-payloads-and-compatibility.md) | Schema contracts, wire payloads and compatibility | Proposed (implemented) | 2026-10-18 |
| [0022](0022-manifest-v1-and-entry-point-map.md) | Manifest version 1 and a separate entry point map | Proposed (implemented; decision 4 refined by proposed 0023) | 2026-10-18 |
| [0023](0023-common-invocation-engine-and-http-rpc-execution.md) | A common invocation engine, with HTTP and RPC as its first transports | Proposed (implemented for HTTP and RPC) | 2026-10-18 |
| [0024](0024-event-delivery-sources-and-local-drivers.md) | Event delivery through binding sources, with local drivers as the first binding | Proposed (implemented) | 2026-10-18 |
| [0025](0025-dev-supervisor-and-process-generations.md) | A development supervisor with one process per generation | Proposed (implemented) | 2026-10-19 |
| [0026](0026-event-safety-analysis-lineage-and-execution-guards.md) | Event safety: static cycle analysis, event lineage and execution guards | Proposed (implemented) | 2026-10-20 |
| [0027](0027-observability-telemetry-and-local-inspection.md) | Observability: telemetry on the OpenTelemetry model and local inspection | Proposed (implemented) | 2026-10-20 |
| [0028](0028-hot-handler-replacement.md) | Hot handler replacement inside a development generation | Proposed (implemented) | 2026-10-20 |
| [0029](0029-binding-provider-protocol-and-versioned-contracts.md) | A binding provider protocol with versioned contracts | Proposed (implemented) | 2026-10-20 |

## Adding an ADR

1. Copy [`template.md`](template.md) to `NNNN-short-kebab-title.md`. Use the next free four-digit number. Numbers are never reused, including for rejected or withdrawn proposals.
2. Fill in every section. Write the context so that a reader without access to the original discussion can follow it. List the alternatives you actually considered and say why each was rejected.
3. Set `Status: Proposed` unless the maintainers have already agreed. If the decision depends on something that is not built, say so in the Decision section.
4. Add a row to the index table above.
5. Link the ADR from the documentation it affects, for example a concept page or a contributor guide.
6. Open a pull request. Use a Conventional Commit such as `docs(adr): add 0012 ...`. A maintainer changes the status to `Accepted` when the decision is agreed.

When you write an ADR:

- Never describe an unimplemented capability as shipped. Use the status terms from the [status model](../status-model.md): *Implemented*, *Accepted design*, *Proposed* and *Planned*.
- Present illustrative APIs as illustrative. Use ADR consequences to name what would make the decision worth revisiting.
- Keep each ADR to one decision. If you find yourself writing two Decision sections, write two ADRs.
