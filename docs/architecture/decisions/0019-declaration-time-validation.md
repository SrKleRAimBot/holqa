# 0019. Declaration-time validation in the SDK

- **Status:** Proposed
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

> **Implementation status:** Implemented in `@holqa/sdk` by the change that adds this ADR; it becomes Accepted when a maintainer approves it. It changes one point of the M0 API design, which left identifier checks to the compiler.

## Context

[ADR 0012](0012-source-inferred-types-and-reply-helpers.md) (decision 5) assigned uniqueness of identifiers across files to compiler diagnostics, and the M0 [API design](../../reference/api-design.md) said that identifiers are validated by the compiler and runtime, not by `defineApp`, so that all invalid identifiers can be reported at once. The compiler is not implemented, and the first framework milestone requires `defineApp` to reject duplicate logical identifiers itself. Developers also get feedback fastest from the editor, before any tool runs.

Validation at declaration time must not turn declarations into something impure: `defineApp` and the factories still must not perform I/O or read the clock, randomness or environment ([ADR 0003](0003-explicit-resource-declarations.md)).

## Decision

1. **Factories validate their own declaration** when called (`queue`, `bucket`, `schedule`, `http.api`, `secret`, `variable`, and handler registrations such as `consume`). They collect every problem in that declaration and throw one `HolqaError` carrying all diagnostics. Identifier problems use `HOLQA_RESOURCE_ID_INVALID`; malformed options use `HOLQA_DECLARATION_INVALID`.
2. **`defineApp` validates the whole application** and throws one `HolqaError` with every problem: an invalid name, malformed handler patterns, non-resource values, resources owned by another application, malformed configuration entries and **duplicate resource identifiers** (`HOLQA_RESOURCE_ID_DUPLICATE`, naming every alias involved). It claims resources only when the whole definition is valid.
3. **The same rules are checked at compile time where the types allow it.** Literal identifiers are checked against the grammar, and duplicate literal identifiers in `defineApp({ resources })` and duplicate aliases in `composeResources` are reported, by intersecting the argument with a `HolqaTypeError<"message">` type that names the problem.
4. Once the compiler exists it reports the same problems with source locations; until then this ADR, if accepted, supersedes ADR 0012 decision 5 for resource identifiers.
5. The identity check is one function in `@holqa/core` (`checkIdentities`) so that the compiler can reuse it ([backlog](../../milestones/m0/backlog.md) HB-33).
6. Graph rules that need handlers (duplicate handler identifiers, references to undeclared resources, one consumer per queue) stay with the compiler, which discovers handler modules. They are not implemented.

## Consequences

### Positive

- An invalid or duplicated identifier fails at the line that declares it, in the editor and at module load, with every problem reported together.
- Static checks need no code generation: they work from the literal types of the declaration.

### Negative

- A stack trace from a factory call is the first report, not a compiler diagnostic with a source location.
- Identifiers computed at run time (`string`) are only checked at run time.
- Compile-time messages appear as a missing `~holqaTypeError` property, which is readable but unusual.

### Revisit when

- The compiler exists and can report the same problems with source locations; the run-time checks then remain as a safety net.

## Alternatives considered

### Validate only in the compiler (the M0 design)

Rejected for this milestone: there is no compiler, and duplicate identifiers must be rejected by `defineApp` itself.

### Throw on the first problem

Rejected: reporting one problem per run makes fixing a declaration slow, for people and agents alike.

## Related

- [Resource identity rules](../../concepts/resource-identity.md)
- [Application model](../../concepts/application-model.md)
- [ADR 0004: Stable logical resource identities](0004-stable-logical-resource-identities.md)
- [ADR 0012: Source-inferred types and reply helpers](0012-source-inferred-types-and-reply-helpers.md)
