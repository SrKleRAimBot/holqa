# 0016. Schema adapters and conversion fidelity

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers
- **Supersedes:** [0006](0006-standard-schema-and-portable-schema-representation.md)

> **Implementation status:** Accepted design, validated by the disposable [schema interoperability experiment](../../../experiments/schema-adapters/README.md) for Zod 4.6.7 and Valibot 1.5.0. No schema support exists in `@holqa/core` or `packages/integrations/*` yet.

## Context

[ADR 0006](0006-standard-schema-and-portable-schema-representation.md) proposed building core generics on Standard Schema and normalizing schemas through library adapters, pending validation with Zod and one other library. M0 did that validation and found:

- Validation and type inference work through structural Standard Schema types alone. The built model and SDK contain no reference to Zod or Valibot.
- Since ADR 0006 was written, Standard Schema has gained a Standard JSON Schema extension (`~standard.jsonSchema`), which Zod 4.6 implements natively and Valibot through a wrapper.
- Generic conversion silently loses constraints. Zod drops `.refine()`, `.superRefine()`, `.trim()` and `.toLowerCase()` without an error, even with `unrepresentable: "throw"`; Valibot mis-describes some formats and defaulted outputs. Only a library-specific adapter that walks the library's internal definitions can detect this, and those internals are not public APIs.
- The same logical contract produces different JSON Schema in each library (Zod adds integer bounds; `required` follows declaration order), and input and output sides differ routinely.

## Decision

1. ADR 0006 decisions 1, 4 and 5 stand: core generics use Standard Schema, Zod is the first integration, and messages carry an explicit `schemaVersion`.
2. The normalized representation is **JSON Schema draft 2020-12 plus Holqa metadata**, not a new schema language: per side (`input`, `output`), a `fidelity` (`verified` when a vendor adapter converted it, `unverified` for the generic Standard JSON Schema path), structured `runtimeOnly` entries (`{ path, kind, detail }`), and the converter's exact library and version.
3. Schema adapters live in integration packages and implement the `SchemaAdapter` contract from `@holqa/core` ([ADR 0013](0013-descriptor-protocol-in-core.md)). An adapter may read its library's internals and must be tested against a corpus for every supported library version.
4. Without a vendor adapter, a schema implementing Standard JSON Schema is accepted with a `HOLQA_SCHEMA_FIDELITY_UNVERIFIED` warning. A schema with neither is rejected with `HOLQA_SCHEMA_UNSUPPORTED`. Constraints enforced only at runtime are reported with their own code and recorded in the manifest. Nothing is silently approximated.
5. Runtime validation needs no adapter: it calls `~standard.validate` and always awaits the result.
6. The wire format of messages and requests is the schema's input side. Transforms must be deterministic decoders.

## Consequences

### Positive

- Users keep their schema library; core has no schema-library dependency.
- The generic path works for any future Standard JSON Schema library, honestly labeled.

### Negative

- Each adapter depends on unstable library internals and must track library releases.
- Fingerprints are library- and version-dependent, so compatibility checking must compare structure, not fingerprints alone.

### Revisit when

- Standard JSON Schema gains a way to report lossy conversion, which would make internal walkers unnecessary.

## Alternatives considered

### Rely on Standard JSON Schema alone

Rejected. Measured to drop refinements silently, which violates the rule that schemas are never silently approximated.

### A Holqa-specific schema representation instead of JSON Schema

Rejected for now. JSON Schema is what OpenAPI and generated clients need, and a second representation would need its own converters. Revisit if compatibility checking needs information JSON Schema cannot hold.

## Related

- [Schema interoperability experiment](../../../experiments/schema-adapters/README.md)
- [Compilation experiment](../../../experiments/compiler/README.md)
- [Type safety and schemas](../../concepts/type-safety-and-schemas.md)
