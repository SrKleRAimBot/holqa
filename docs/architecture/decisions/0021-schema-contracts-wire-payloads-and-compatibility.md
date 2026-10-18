# 0021. Schema contracts, wire payloads and compatibility

- **Status:** Proposed
- **Date:** 2026-10-18
- **Deciders:** Holqa maintainers
- **Refines:** [0016](0016-schema-adapters-and-conversion-fidelity.md) decision 2 (where fidelity is recorded). Proposed; once accepted, this supersedes that part of 0016.

> **Implementation note:** Decision 3 said drivers did not use the envelope yet; since [ADR 0024](0024-event-delivery-sources-and-local-drivers.md), queue drivers receive the `holqa.message/1` envelope and consumers accept the queue's own `schemaVersion` (newer versions are retried, older ones dead-lettered).

## Context

[ADR 0016](0016-schema-adapters-and-conversion-fidelity.md) accepted Standard Schema for validation, per-library adapters for portable JSON Schema, and the rule that nothing is silently approximated. It left open:

- which values may cross an execution boundary, and in what form;
- where the adapter contract, the normalizer, fingerprints and compatibility checks live;
- what a fingerprint covers, so that equivalent schemas agree;
- how a change to a contract is classified, and what a developer must do about it;
- what a validation error must contain for a runtime to name the failing field.

ADR 0016 decision 2 put a `fidelity` on each side of the normalized representation. In practice fidelity depends only on which converter produced the description (a vendor adapter or the generic Standard JSON Schema path), which is the same for both sides, so per-side fidelity would duplicate one fact and allow the two sides to disagree.

The SDK already validated queue messages on `send` and again on delivery, but handed the caller's object to the driver unchanged, so a value with no JSON form (a `Date`, a `bigint`) reached the runtime. Issue paths were dotted strings only. Messages carried no version.

## Decision

1. **JSON is the only ordinary wire format.** Queue messages, RPC payloads and serialized contracts are JSON. `toWirePayload` converts a value to an exact JSON copy and rejects everything else with `HOLQA_PAYLOAD_NOT_SERIALIZABLE` and a path. Object properties whose value is `undefined` are omitted, as in JSON; nothing else is dropped or coerced. Binary data uses an explicit `PayloadCodec` or a bucket; streams need separate transport handling.
2. **The wire carries the schema's input form, validated after encoding.** `prepareWirePayload` encodes first and validates the encoded copy, so the schema checks exactly what is transmitted. A schema's output is never sent. `queue(...).send` uses it, and drivers receive the validated copy.
3. **Messages may travel in a versioned envelope.** `holqa.message/1` carries `schemaVersion`, an optional `fingerprint` and the payload. Consumers accept only listed versions (`HOLQA_PAYLOAD_VERSION_UNSUPPORTED`) and reject malformed envelopes (`HOLQA_PAYLOAD_MALFORMED`) before validating. Drivers do not use the envelope yet.
4. **Validation issues are structured.** Each issue has a dotted `path`, `segments`, an RFC 6901 `pointer` and optional scalar library `details`; the rejected input is never copied. `Diagnostic` gains an optional `details` object, and `HOLQA_INPUT_INVALID` lists every issue there.
5. **Layering.** `@holqa/core` owns runtime contracts: validation, wire payloads, envelopes, codecs and the `SchemaAdapter` interface (`describe(schema, side)` returning a description with structured runtime-only constraints, or a problem with a path and hint). `@holqa/compiler` owns compile-time work: `normalizeSchema`, `canonicalizeJsonSchema`, `fingerprintSchemaContract` and `checkSchemaCompatibility`, because fingerprints use the compiler's canonical JSON. Adapters live in integration packages and depend only on core; `@holqa/zod` is the first.
6. **The canonical contract** (`holqa.schema-contract/1`) is JSON Schema draft 2020-12 per side plus one `source` (vendor, library, `verified` or `unverified` fidelity) for the whole contract, and runtime-only constraints per side. This proposes replacing ADR 0016's per-side fidelity. The input side must be portable; an unrepresentable output side is recorded, not an error. Canonicalization sorts set-like keywords (`required`, `type`, `enum`, `anyOf`, `oneOf`, `allOf`) and never removes a constraint.
7. **Fingerprints** are `sha256:` over the canonical JSON of format, dialect, encoding, both sides' canonical JSON Schemas, output representability and runtime-only `path` and `kind`. They exclude the source, human-readable text and the declared version. `schemaVersion` stays a separate, developer-declared positive integer.
8. **Compatibility policy.** The checker compares input sides in both directions and classifies each change as `safe`, `potentially-breaking`, `unverifiable` or `breaking` by role: for `message`, the next contract rejecting previous data is breaking and the reverse is potentially breaking; for `request`, only the former matters; for `response`, only the latter. Uncertain findings are at most potentially breaking; unanalyzable ones are unverifiable. Two changes ignore the role: a changed contract format or encoding is breaking, and an unverified contract makes the comparison unverifiable. A breaking change without a version increase is an error (`HOLQA_SCHEMA_CHANGE_BREAKING`); with one, a warning (`HOLQA_SCHEMA_MIGRATION_REQUIRED`). A decreased version is an error. The checker assumes producers send only declared properties.

Implementation status: everything above is implemented and tested. Storing records in a manifest, comparing against a deployed manifest, CLI integration and a migration engine are **Planned**.

## Consequences

### Positive

- A message that the producer's schema accepts is, byte for byte, the message the consumer validates.
- An incompatible change to a message contract fails before deployment, with the path and kind of each change, instead of stranding queued messages.
- Validation failures name the field in a machine-readable form.
- Equivalent schemas share a fingerprint regardless of declaration order, and the report is JSON that migration tooling can start from.

### Negative

- `queue(...).send` now rejects values without a JSON form that it previously passed to the driver, and sends a copy rather than the caller's object. Code relying on either behavior breaks; no runtime driver depends on it yet.
- The checker is conservative and incomplete: `$ref`, `allOf` and similar constructs are unverifiable, regular expressions and formats are compared by equality, and the declared-properties assumption can miss an undeclared property sent by a non-strict producer.
- Fingerprints remain library-sensitive (ADR 0016).

### Revisit when

- Runtime drivers adopt the message envelope, or a binary wire format is needed.
- Real schemas commonly produce unverifiable results, which would justify `$ref` resolution or a richer comparison.

## Alternatives considered

### Normalization and fingerprints in `@holqa/core`

Rejected. Fingerprints must use the compiler's canonical JSON, and normalization is a compile-time concern. Keeping them in the compiler keeps core small; adapters still need only core.

### Validating the caller's value and sending it unchanged

Rejected. A schema that accepts any value would let a `Date` reach the wire, and later mutation of the caller's object could change what was sent.

### A single "breaking or not" result

Rejected. Queues, requests and responses are read by different parties, and rolling deployments make some changes risky without making them wrong. Four classifications and a role keep both cases visible.

## Related

- [Schema contracts reference](../../reference/schema-contracts.md)
- [ADR 0016](0016-schema-adapters-and-conversion-fidelity.md)
- [Type safety and schemas](../../concepts/type-safety-and-schemas.md)
- [`examples/schema-evolution`](../../../examples/schema-evolution/README.md)
