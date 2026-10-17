# 0006. Standard Schema and a portable schema representation

- **Status:** Proposed
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

> **Implementation status:** Proposed design. No schema support exists in the repository: no Standard Schema integration, normalized representation, fingerprints or compatibility checks. The planned Zod, Valibot and Effect integration packages are directories with a README only. This ADR needs validation by implementing the normalized representation for at least Zod and one other library.

## Context

Holqa contracts (queue messages, HTTP bodies, RPC inputs and outputs, environment variables) need both a static TypeScript type and runtime validation, because TypeScript cannot validate data that crosses a trust boundary or data written by an earlier deployment. Developers already use different schema libraries, mainly Zod, Valibot and Effect Schema.

[Standard Schema](https://standardschema.dev) is a small shared interface (`~standard`) implemented by these libraries. It provides validation and inferred input and output types. That covers type inference and runtime validation, but the future compiler needs more:

- Portable metadata (JSON Schema, where faithful) for manifests, OpenAPI and generated clients.
- Stable fingerprints to detect contract changes between deployments.
- Schema evolution diagnostics and compatibility checks between versions.
- Explicit serialization and deserialization rules, including for transformations such as dates or branded types.
- Clear reporting when a schema cannot be represented portably.

Not every schema can be expressed as JSON Schema. Refinements, transforms and custom validators often cannot. Pretending otherwise produces contracts that lie.

## Decision (proposed)

1. **Core generics are built on the Standard Schema interface**, not on Zod or any other single library. Inference and runtime validation go through `~standard`.
2. **Holqa defines a normalized internal schema representation** for compiler purposes: portable metadata, fingerprints, compatibility checks and serialization rules. Library-specific adapters (Zod first, then Valibot and Effect Schema) convert to it.
3. **Unsupported or lossy constructs produce explicit diagnostics.** A schema that cannot be safely normalized is reported, not approximated. Whether a refinement is "runtime-only" (it validates but is absent from portable metadata) or an error has to be decided per construct and documented.
4. **Zod is the first-class initial integration.** Valibot and Effect Schema follow through adapters.
5. **Messages are versioned.** Contracts such as queue messages carry an explicit `schemaVersion`, and compatibility between versions is a compiler concern, not something left to TypeScript.

## Consequences

### Positive (expected)

- Applications are not locked into one schema library.
- One normalized form serves manifests, generated clients, OpenAPI and compatibility checks.
- Explicit diagnostics for lossy schemas keep published contracts honest.

### Negative (expected)

- Each adapter has to map a library's whole schema surface, and keep up as the library changes.
- The normalized representation is a significant design effort, and getting fingerprints stable across library versions is hard.
- Some idiomatic schemas (heavy transforms) will be rejected or only partly portable, which users may find surprising.

### Validation needed before acceptance

- Normalize a realistic set of Zod schemas and one other library's schemas into the same representation.
- Demonstrate stable fingerprints and useful diagnostics for unsupported constructs.
- Decide how transformed (decoded) output types are serialized across process boundaries.

## Alternatives considered

### Couple core generics directly to Zod

Rejected. It would force one library on users and make the core depend on Zod's release cadence.

### Standard Schema alone, with no normalized representation

Rejected. Standard Schema has no portable metadata, fingerprints or compatibility information, all of which the compiler needs.

### JSON Schema as the single source of truth

Rejected. Authoring contracts directly in JSON Schema loses TypeScript inference ergonomics, and JSON Schema cannot express every runtime validation users rely on.

### Holqa's own schema library

Rejected. It would duplicate mature libraries and make migration harder for existing users.

## Related

- [Type safety and schemas](../../concepts/type-safety-and-schemas.md)
- [Compiler](../compiler.md)
- [Integrations](../../integrations/index.md)
- [ADR 0007: Separate compiler and runtime](0007-separate-compiler-and-runtime.md)
- Standard Schema: <https://standardschema.dev>
