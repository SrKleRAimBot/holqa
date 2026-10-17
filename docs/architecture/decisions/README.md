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
| [0004](0004-stable-logical-resource-identities.md) | Stable logical resource identities | Accepted (only identifier validation is implemented) | 2026-10-17 |
| [0005](0005-infrastructure-independent-resource-contracts.md) | Infrastructure-independent resource contracts | Proposed | 2026-10-17 |
| [0006](0006-standard-schema-and-portable-schema-representation.md) | Standard Schema and a portable schema representation | Proposed | 2026-10-17 |
| [0007](0007-separate-compiler-and-runtime.md) | Separate compiler and runtime | Accepted (not implemented) | 2026-10-17 |
| [0008](0008-agent-instructions-and-skills.md) | Agent instructions and skill organization | Accepted | 2026-10-17 |
| [0009](0009-test-placement-and-typescript-standards.md) | Test placement and TypeScript standards | Accepted | 2026-10-17 |
| [0010](0010-typescript-6-until-tooling-supports-7.md) | TypeScript 6 until the toolchain supports TypeScript 7 | Accepted | 2026-10-17 |
| [0011](0011-path-aliases-in-library-packages.md) | `@/` path aliases in library packages | Accepted | 2026-10-17 |

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
