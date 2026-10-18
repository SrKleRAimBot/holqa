# Schema contracts

> **Status:** **Implemented** in `@holqa/core` (validation, wire payloads, message envelopes, adapter contract), `@holqa/compiler` (normalization, fingerprints, compatibility checks) and `@holqa/zod` (the Zod 4 adapter). Recording contracts in a manifest, and running the compatibility check against a deployed manifest from the CLI, are **Planned**. See [ADR 0021](../architecture/decisions/0021-schema-contracts-wire-payloads-and-compatibility.md).

Every value that crosses an execution boundary in Holqa (a queue message, an RPC payload, a serialized resource contract) is described by a schema. This page defines what Holqa does with that schema: how values are validated and encoded, how a schema becomes a portable contract, how contracts are identified, and how changes to them are classified.

## Overview

| Step | API | Package | Result |
| --- | --- | --- | --- |
| Validate | `validateInput(schema, value, subject)` | `@holqa/core` | The schema's output, or `InputValidationError` (`HOLQA_INPUT_INVALID`) with per-field issues. |
| Encode for the wire | `toWirePayload`, `prepareWirePayload`, `createMessageCodec` | `@holqa/core` | Exact JSON data, validated by the schema, or `PayloadError` (`HOLQA_PAYLOAD_NOT_SERIALIZABLE`). |
| Decode from the wire | `decodeJsonPayload`, `decodeMessageEnvelope`, `createMessageCodec` | `@holqa/core` | Untrusted JSON, then the schema's output. |
| Describe portably | `normalizeSchema(schema, { subject, adapters })` | `@holqa/compiler` | A canonical `SchemaContract`, warnings, or `HOLQA_SCHEMA_UNSUPPORTED`. |
| Identify | `fingerprintSchemaContract(contract)`, `describeSchemaContract(...)` | `@holqa/compiler` | `sha256:<64 hex digits>`, and a versioned `SchemaContractRecord`. |
| Compare | `checkSchemaCompatibility(previous, next, { role, subject })` | `@holqa/compiler` | Classified changes and diagnostics. |
| Adapt a library | `zodAdapter`, `createZodAdapter()` | `@holqa/zod` | A `SchemaAdapter` for Zod 4 (classic and Mini). |

## Validation

Holqa uses [Standard Schema](https://standardschema.dev) v1 as its validation boundary. Any library that implements it works for validation; no adapter is needed. `validateInput` always awaits, because schemas may validate asynchronously.

Schemas have two sides, and Holqa keeps them apart:

| Side | Type | Meaning |
| --- | --- | --- |
| Input | `InferInput<Schema>` | What producers pass to `send`, and what travels on the wire. |
| Output | `InferOutput<Schema>` | What consumers receive after validation and transformation. |

A schema such as `z.codec(z.iso.datetime(), z.date(), ...)` therefore has input `string` and output `Date`. The same schema validates a message when it is published and again when it is received.

### Validation errors

A failed validation throws `InputValidationError`, a `HolqaError` with one `HOLQA_INPUT_INVALID` diagnostic. Each issue identifies the failing field:

| Field | Example | Meaning |
| --- | --- | --- |
| `message` | `Too small: expected number to be >=1` | The library's message. |
| `path` | `lines.0.quantity` | Dotted path; empty for the whole value. |
| `segments` | `["lines", 0, "quantity"]` | The path as keys and indexes. |
| `pointer` | `/lines/0/quantity` | RFC 6901 JSON Pointer. |
| `details` | `{ "code": "too_small", "minimum": 1 }` | Optional. Scalar, library-specific facts about the issue. |

The diagnostic's `details` carry `{ subject, issues }` with the same fields, so `--json` consumers can point at the field. Neither the message nor `details` ever contains the rejected value: Holqa drops the `input` property that some libraries attach to issues.

## Wire payloads

For this release, every ordinary payload is JSON: queue messages, RPC payloads and serialized contracts. Binary bodies, files and streams are not JSON payloads.

### Encoding rules

`toWirePayload(value, subject)` converts a value to the exact JSON data that crosses the boundary, as a fresh copy:

| Value | Result |
| --- | --- |
| `null`, booleans, strings | Kept. |
| Finite numbers | Kept. `-0` becomes `0`. |
| Arrays | Copied. A hole or an `undefined` entry is rejected. |
| Plain objects (prototype `Object.prototype` or `null`) | Copied. A property whose value is `undefined` is omitted, as in JSON. |
| `NaN`, `Infinity`, `bigint`, symbols, functions | Rejected. |
| Symbol-keyed properties, circular references | Rejected. |
| `Date`, `Map`, `Set`, typed arrays, `ArrayBuffer`, class instances | Rejected. `Date`, `Map`, `Set` and binary data get a hint naming the portable alternative, as do bigints. |

Rejections throw `PayloadError` with code `HOLQA_PAYLOAD_NOT_SERIALIZABLE` and the JSON path of the first offending value (for example `$.lines[0].placedAt`), in `path` and in the diagnostic's `details`. The value itself is never included.

### What is sent: the input form, validated after encoding

`prepareWirePayload(schema, value, subject)` encodes first and then validates the encoded copy with the schema. The schema therefore checks exactly what is transmitted, and a property omitted because it was `undefined` is validated as absent. The schema's output is discarded: the wire always carries the input form.

This is what makes transformations safe. A transformation that produces a native `Date` is never assumed to produce a JSON message. The `Date` exists only on the consumer side, after the consumer decodes the ISO string with the same schema. If a producer passes a `Date` where the schema accepts any value, encoding fails instead of silently producing a string.

The SDK's `queue(...).send` uses `prepareWirePayload` and hands the runtime driver the validated JSON copy.

### Message envelopes

`createMessageCodec(schema, { schemaVersion, subject, acceptedVersions?, fingerprint? })` produces and reads versioned envelopes:

```json
{"format":"holqa.message/1","schemaVersion":2,"payload":{"orderId":"o_1","placedAt":"2026-10-18T09:00:00Z"}}
```

| Field | Meaning |
| --- | --- |
| `format` | Always `holqa.message/1`. Other values are rejected. |
| `schemaVersion` | The contract version the producer validated against. A positive integer. |
| `fingerprint` | Optional. The producer's contract fingerprint. |
| `payload` | The wire (input) form of the message. |

On decode, unknown envelope properties are ignored. A malformed envelope or payload (invalid UTF-8, invalid JSON, a missing or wrong field) throws `PayloadError` with `HOLQA_PAYLOAD_MALFORMED`. A `schemaVersion` other than the codec's own version and those listed in `acceptedVersions` throws `HOLQA_PAYLOAD_VERSION_UNSUPPORTED`. Only then is the payload validated with the schema. A message produced under an older contract is therefore never handed to a consumer silently: it is either explicitly accepted, rejected by version, or rejected with the failing field.

The envelope is a core contract. Runtime drivers do not use it yet; `QueueDriver.send` still receives the validated JSON payload.

### Binary payloads

`PayloadCodec<Value>` is the explicit interface for anything that is not JSON:

| Codec | Media type | Behavior |
| --- | --- | --- |
| `jsonPayloadCodec` | `application/json` | UTF-8 JSON with the encoding rules above. |
| `bytesPayloadCodec` | `application/octet-stream` | Bytes pass through as an independent copy. |

Buckets already store bytes outside the JSON path. Streams need separate transport handling and are not payloads.

## Portable contracts

A `SchemaContract` is Holqa's canonical, JSON-serializable description of a schema: JSON Schema draft 2020-12 per side, plus the metadata needed to trust it.

```json
{
  "format": "holqa.schema-contract/1",
  "dialect": "https://json-schema.org/draft/2020-12/schema",
  "encoding": "json",
  "source": { "vendor": "zod", "library": "zod@4.6.7", "fidelity": "verified" },
  "input": { "jsonSchema": { "type": "object" }, "runtimeOnly": [] },
  "output": { "representable": false, "problem": { "path": "$.placedAt", "reason": "Date objects are not JSON data." } }
}
```

The example is abbreviated: `input.jsonSchema` would contain the full canonical schema.

| Field | Meaning |
| --- | --- |
| `source.fidelity` | `verified` when a library adapter produced the description and reported every construct it could not express; `unverified` when the schema's own Standard JSON Schema converter produced it. |
| `input` | The wire side. Always portable; a schema whose input cannot be described is rejected. |
| `output` | The decoded side. It may be unrepresentable (for example a `Date`), which is recorded and is not an error. |
| `runtimeOnly` | Constraints validated at runtime that the JSON Schema does not express, each with a `path`, a `kind` and a `detail`. |

### Normalization

`normalizeSchema(schema, { subject, adapters })` picks the adapter whose `vendor` matches the schema's Standard Schema vendor:

| Situation | Outcome |
| --- | --- |
| A matching adapter | Verified contract. One `HOLQA_SCHEMA_RUNTIME_ONLY` warning per runtime-only constraint on the input side. |
| No adapter, but the schema implements Standard JSON Schema | Unverified contract and a `HOLQA_SCHEMA_FIDELITY_UNVERIFIED` warning. Generic converters can drop constraints silently. |
| Neither | `HOLQA_SCHEMA_UNSUPPORTED`. |
| The input side cannot be described | `HOLQA_SCHEMA_UNSUPPORTED` with the path and, where possible, a hint. |
| The adapter throws or returns non-JSON output | `HOLQA_SCHEMA_UNSUPPORTED`; the failure is reported, never hidden. |

Normalization runs the schema library's code in-process (adapters call into the library, and the generic path calls the schema's own converter). It checks values structurally but does not sandbox them; only normalize schemas from code you would also execute. See [untrusted build-time execution](../concepts/security.md#untrusted-build-time-execution).

Nothing is ever approximated. A construct the description cannot express is either runtime-only (still validated, and visible in the contract) or a reason to reject the schema.

### Canonical form

`canonicalizeJsonSchema` rewrites a JSON Schema so that schemas which accept the same values and differ only in presentation become identical:

- The top-level `$schema` is removed; the contract fixes the dialect.
- `required` and `type` lists are de-duplicated and sorted; a one-element `type` list becomes a string.
- `enum` values and `anyOf`, `oneOf` and `allOf` members are de-duplicated and sorted by canonical JSON, unless a `$ref` anywhere in the schema points into one of these lists; then no list in that schema is reordered.
- `const`, `default`, `examples` and `prefixItems` keep their order.
- Object keys are sorted when the contract is serialized with `canonicalJsonStringify`.

Canonicalization never removes a constraint. It does not rename `$defs` entries, and it does not merge equivalent but differently written schemas (for example `anyOf` of two types versus a `type` list).

## Fingerprints and versions

`fingerprintSchemaContract(contract)` resolves to `sha256:` followed by 64 lowercase hex digits: the SHA-256 of the canonical JSON of the contract's wire-relevant parts.

| Included | Excluded |
| --- | --- |
| `format`, `dialect`, `encoding` | `source` (vendor, library, fidelity) |
| Both sides' canonical JSON Schemas | Human-readable `detail` and `reason` text |
| Whether the output is representable | The declared `schemaVersion` |
| The `path` and `kind` of every runtime-only constraint | |

Equivalent canonical schemas produce identical fingerprints, whatever the declaration order. Switching libraries keeps the fingerprint only when both libraries produce the same canonical description, which is often not the case (Zod adds integer bounds and string patterns that other libraries do not). A changed fingerprint means "the contract may have changed"; the compatibility checker decides whether it matters.

The declared `schemaVersion` is separate from the fingerprint. It is the developer's statement of intent and the key future migration tooling will use. `describeSchemaContract(schema, { subject, schemaVersion, adapters })` combines contract, fingerprint and version into a `SchemaContractRecord`, rejecting a version that is not a positive integer with `HOLQA_SCHEMA_VERSION_INVALID`.

## Compatibility

`checkSchemaCompatibility(previous, next, { role, subject })` compares the wire (input) sides of two records. It looks at both directions:

- **Backward:** can the next contract read data written under the previous one?
- **Forward:** can the previous contract read data written under the next one?

### Policy

| Role | Next rejects previous data (backward) | Previous rejects next data (forward) |
| --- | --- | --- |
| `message` (queues) | **breaking**: queued messages from old producers are rejected | **potentially breaking**: old consumers still running during a rollout reject new messages |
| `request` (public APIs) | **breaking**: old clients' requests are rejected | safe |
| `response` (public APIs) | safe | **breaking**: old clients reject new responses |

Each change is then adjusted by how sure the checker is:

| Certainty | Meaning | Classification |
| --- | --- | --- |
| `definite` | Such data exists. | The policy's classification. |
| `possible` | Such data may exist (for example, two different regular expressions). | At most potentially breaking. |
| `unknown` | The change uses constructs the checker does not analyze. | Unverifiable. |

### Diagnostics

| Situation | Code | Severity |
| --- | --- | --- |
| Breaking change, `schemaVersion` not increased | `HOLQA_SCHEMA_CHANGE_BREAKING` | error |
| Breaking change, `schemaVersion` increased | `HOLQA_SCHEMA_MIGRATION_REQUIRED` | warning |
| Potentially breaking change | `HOLQA_SCHEMA_CHANGE_POTENTIALLY_BREAKING` | warning |
| Unverifiable change | `HOLQA_SCHEMA_CHANGE_UNVERIFIABLE` | warning |
| `schemaVersion` decreased | `HOLQA_SCHEMA_VERSION_INVALID` | error |

Each diagnostic's `details` carry the `path`, `kind`, `direction`, `classification` and both versions. The report's `compatible` is `false` when any diagnostic is an error. The whole report is JSON, so it can be stored as the starting point for migration tooling. A migration engine is **Planned**; increasing `schemaVersion` records the intent and turns the error into a warning, but does not migrate data.

### Change kinds

Kinds are stable strings, described from the previous contract to the next.

| Narrowing kind | Opposite kind | Example |
| --- | --- | --- |
| `type-narrowed` | `type-widened` | `number` → `integer`; nullability removed. |
| `value-restricted` | `value-unrestricted` | A free string becomes an enum. |
| `enum-value-removed` | `enum-value-added` | `"urgent"` removed from an enum or discriminated union. |
| `constraint-tightened` | `constraint-relaxed` | `minimum`, `maxLength`, `minItems` or `multipleOf` tightened. |
| `required-property-added` | `required-property-removed` | A new required field. |
| `optional-became-required` | `required-became-optional` | `.optional()` removed. |
| `property-removed` | `property-added` | A field removed while undeclared fields are rejected. |
| `additional-properties-restricted` | `additional-properties-allowed` | `z.object` → `z.strictObject`. |
| `value-rejected` | `value-allowed` | A tuple shortened. |
| `pattern-changed`, `format-changed` | (same) | A pattern or format added or changed. |
| `unsupported-keyword` | (same) | `allOf`, `$ref`, `if`/`then`, `not`, ... changed. |
| `runtime-constraint-added` | `runtime-constraint-removed` | A `.refine()` added or removed. Classified as possible. |
| `fidelity-unverified` | | Either contract is unverified. Unverifiable for every role. |
| `contract-format-changed` | | The contract format, dialect or encoding differs. Breaking for every role. |

### What the checker analyzes

| Analyzed | Not analyzed (changes are unverifiable) |
| --- | --- |
| `type` (with `integer` inside `number`), `enum`, `const` | `$ref`, `$defs` changes, `allOf`, `not`, `if`/`then`/`else` |
| `properties`, `required`, `additionalProperties` | `patternProperties`, `propertyNames`, `dependentSchemas`, `unevaluated*` |
| `items`, `prefixItems`, `minItems`, `maxItems` | `contains`, `uniqueItems`, `minProperties`, `maxProperties` on the reader |
| `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` | Regular-expression inclusion (different patterns are "possible") |
| `minLength`, `maxLength`, `pattern`, `format` | Format inclusion (different formats are "possible") |
| `anyOf`, `oneOf` (a value is accepted when one member accepts it); for `oneOf`, members not provably disjoint by type or `const`/`enum` discriminator are reported as possibly overlapping | `anyOf` and `oneOf` in the same schema |
| `enum` and `const` with scalar values | `enum` and `const` with object or array values |

Annotations (`title`, `description`, `default`, `examples`, `deprecated`, ...) never affect compatibility.

**Assumption:** producers send only declared properties. Adding an optional property is therefore safe for a consumer that ignores undeclared properties, even though a non-strict producer schema would have let an undeclared property of any type through.

## Evolution guidance

"Strict" means the schema rejects undeclared properties (`z.strictObject`, `additionalProperties: false`).

| Change | Queue message | Request | Response |
| --- | --- | --- | --- |
| Add an optional property | Safe (potentially breaking for strict old consumers) | Safe | Safe (breaking for strict old clients) |
| Add a required property | Breaking | Breaking | Safe (breaking for strict old clients) |
| Make a required property optional | Potentially breaking | Safe | Breaking |
| Remove an optional property | Safe (breaking if the new schema is strict) | Safe (breaking if the new schema is strict) | Safe |
| Remove a required property | Potentially breaking (breaking if the new schema is strict) | Safe (breaking if the new schema is strict) | Breaking |
| Add an enum value | Potentially breaking | Safe | Breaking |
| Remove an enum value | Breaking | Breaking | Safe |
| Tighten a constraint | Breaking | Breaking | Safe |
| Relax a constraint | Potentially breaking | Safe | Breaking |
| Change a type | Breaking | Breaking | Breaking |
| Add a refinement | Potentially breaking | Potentially breaking | Safe |

For a breaking change to a queue message:

1. Prefer a compatible change: add the new field as optional, or accept both forms with a union.
2. Otherwise increase `schemaVersion`. The checker then reports `HOLQA_SCHEMA_MIGRATION_REQUIRED` instead of failing.
3. Drain or migrate messages written with the old version before the new consumer reads them. A consumer codec accepts only its own version and those listed in `acceptedVersions`; list an old version only when the new schema still accepts its messages.

## Zod support

`@holqa/zod` is the first adapter. It converts with Zod's own JSON Schema generator and walks Zod's internal definitions to report what that generator drops or misdescribes. Zod classic (`zod`) and Zod Mini (`zod/mini`) 4.x are supported; other major versions are rejected when the adapter is created.

| Construct | Input (wire) side | Output side |
| --- | --- | --- |
| `z.object`, `z.strictObject`, `z.looseObject` | Described | Described (Zod adds `additionalProperties: false`) |
| `z.string()` with length, formats (`z.email()`, `z.iso.datetime()`, ...), `.regex()` | Described | Described |
| `z.number()`, `z.int()` with bounds and `multipleOf` | Described | Described |
| `z.boolean()`, `z.null()`, `z.literal()`, `z.enum()` | Described | Described |
| `z.array()`, `z.tuple()`, `z.record()` | Described | Described |
| `.optional()`, `.nullable()`, `.readonly()` | Described | Described |
| `z.union()`, `z.discriminatedUnion()`, `z.intersection()` | Described | Described |
| Recursive schemas (getters, `z.lazy()`) | Described with `$ref` | Described with `$ref` |
| `z.unknown()`, `z.any()` | Described as `{}`; non-JSON values still fail encoding | Described |
| `.default()`, `.prefault()` | Optional, with `default` | Required |
| `.refine()`, `.superRefine()`, `.check()` | Runtime-only (`refinement`) | Runtime-only |
| `.trim()`, `.toLowerCase()`, other value rewrites | Runtime-only (`rewrite`) | Runtime-only |
| `z.coerce.*` | Runtime-only (`coercion`) | Described |
| `.catch()` | Runtime-only (`fallback`) | Described |
| `z.preprocess()` | Runtime-only (`preprocess`) | Described |
| `.pipe(schema)` | The first schema; the second is runtime-only (`pipe`) | The second schema |
| `.transform()` | Described | Unrepresentable |
| `z.codec(wire, decoded, ...)` | The wire schema | The decoded schema, if portable |
| `z.date()`, `z.bigint()`, `z.map()`, `z.set()`, `z.symbol()`, `z.undefined()`, `z.void()`, `z.nan()`, `z.function()`, `z.custom()`, `z.promise()`, `z.file()`, `z.success()` | `HOLQA_SCHEMA_UNSUPPORTED` | Unrepresentable |
| A Zod type the adapter does not know | `HOLQA_SCHEMA_UNSUPPORTED` | Unrepresentable |

### Limitations

- The adapter reads Zod's internal definitions (`_zod.def`), which are not a public API. Unknown types fail and unknown checks become runtime-only, so a Zod upgrade fails visibly rather than silently. The test corpus in `packages/integrations/zod/tests` must pass for every supported Zod version.
- Zod's generated JSON Schema differs from other libraries' for the same logical contract (integer bounds of ±2^53−1, long string-format patterns). Fingerprints are therefore library-sensitive.
- `oneOf` exclusivity is checked only by proving members disjoint (distinct types or discriminator values). Zod discriminated unions satisfy this; other overlapping `oneOf` members are reported as potentially breaking.

## Related

- [Type safety and schemas](../concepts/type-safety-and-schemas.md)
- [Schema libraries](../integrations/schema-libraries.md)
- [Diagnostic codes](diagnostic-codes.md)
- [ADR 0016: schema adapters and conversion fidelity](../architecture/decisions/0016-schema-adapters-and-conversion-fidelity.md)
- [ADR 0021: schema contracts, wire payloads and compatibility](../architecture/decisions/0021-schema-contracts-wire-payloads-and-compatibility.md)
- [`examples/schema-evolution`](../../examples/schema-evolution/README.md)
