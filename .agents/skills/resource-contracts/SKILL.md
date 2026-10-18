---
name: resource-contracts
description: Rules and procedures for Holqa's contract layer - stable logical resource identifiers and their grammar (ResourceId, parseResourceId), schema contracts built on Standard Schema with Zod as the first integration, the normalized portable schema representation, schema versioning and evolution, deterministic canonical JSON serialization, and the diagnostic-code policy. Use when touching resource identity, schemas, validation, manifest or serialized output, adding or changing a diagnostic code, or designing typed resource definitions and message contracts.
---

# Resource contracts and schema design

## Purpose

Contracts are the part of Holqa that outlives a single deployment: resource IDs identify persistent infrastructure, schemas describe data that may have been written by older versions, and diagnostics are matched by tools and agents. Mistakes here are expensive to undo. This skill covers what exists, what is designed, and how to change either safely.

## When to use

- Editing `packages/core/src/identity/**`, `packages/core/src/diagnostics/**`, `packages/core/src/schema/**`, `packages/core/src/wire/**`, `packages/compiler/src/manifest/**`, `packages/compiler/src/schema/**`, or `packages/integrations/zod/**`.
- Designing resource definitions, message schemas, wire payloads, or schema adapters.
- Adding a diagnostic code.
- Producing anything that must be byte-for-byte reproducible.

## Status at a glance

| Item | Status |
| --- | --- |
| `ResourceId`, `parseResourceId`, `isResourceId`, `maxResourceIdLength` | **Implemented** (`@holqa/core`) |
| `Diagnostic`, `createDiagnostic`, `formatDiagnostic`, `diagnosticCodes` | **Implemented** (`@holqa/core`) |
| `canonicalJsonStringify`, `CanonicalJsonError`, `CanonicalJsonValue` | **Implemented** (`@holqa/compiler`) |
| Standard Schema validation with structured issues (`validateInput`, `InputValidationError`) | **Implemented** (`@holqa/core`) |
| JSON wire payloads, message envelopes, payload codecs, the `SchemaAdapter` contract | **Implemented** (`@holqa/core`) |
| Normalized contracts, canonical JSON Schema, fingerprints, compatibility checks | **Implemented** (`@holqa/compiler`; ADR 0021) |
| Zod adapter | **Implemented** (`@holqa/zod`) |
| Manifest version 1 and its JSON Schema, contract records in its schema table, `validateManifest` | **Implemented** (`@holqa/compiler`; ADR 0022) |
| Comparing with a deployed manifest, migration engine | Planned |

The authoritative description is [docs/reference/schema-contracts.md](../../../docs/reference/schema-contracts.md).

## Instructions

### 1. Stable identifiers

- Grammar: `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`, 1–63 characters. Valid: `orders`, `order-processing`, `orders.process`, `v2`. Invalid: `Orders`, `1orders`, `orders-`, `orders--queue`, `orders_queue`.
- The grammar is an initial proposal and may be revised before 1.0, but any change requires an ADR update (ADR 0004) and tests for every newly accepted or rejected form.
- Always validate with `parseResourceId(value: unknown)`. It never throws; failures return `HOLQA_RESOURCE_ID_INVALID` with a hint.
- Only `parseResourceId` may cast to `ResourceId`. Do not add helpers that brand without validating.
- IDs are explicit, never derived from TypeScript property names, file paths, or array positions. Renaming a variable must not change identity.

```ts
const result = parseResourceId(input);
if (!result.ok)
  return err(result.error);   // propagate the diagnostic; do not rethrow as a string
const id = result.value;      // ResourceId
```

### 2. Schema contracts

- Core generics depend on the **Standard Schema** interface (the `~standard` property with `validate`, `vendor`, and inferred input/output types), not on Zod types.
- Zod is the first integration (`@holqa/zod`); Valibot and Effect Schema adapters are planned in `packages/integrations/*`. Never import a schema library from `core` or `compiler`.
- Infer input and decoded output separately; do not assume they are the same type.
- Validate at every trust boundary (HTTP input, queue messages, storage events, config). TypeScript types are not validation.
- Standard Schema alone cannot provide JSON Schema, fingerprints, or compatibility data. `normalizeSchema` (`@holqa/compiler`) builds a `SchemaContract` through a library adapter: canonical JSON Schema per side, `source` with fidelity, and structured `runtimeOnly` constraints.
- If a schema cannot be normalized faithfully, an adapter returns a problem (reported as `HOLQA_SCHEMA_UNSUPPORTED`) or records a runtime-only constraint (`HOLQA_SCHEMA_RUNTIME_ONLY`). Never emit an approximate JSON Schema silently, and never add a construct to an adapter's supported list without a corpus test.
- Adapters live in `packages/integrations/*`, depend only on `@holqa/core`, and may read library internals. Unknown library types must fail; unknown checks must become runtime-only.
- Values crossing an execution boundary are JSON. Use `prepareWirePayload` (encode, then validate the encoded copy) rather than validating and sending the caller's object, and never send a schema's output. Binary data needs an explicit `PayloadCodec`.

### 3. Versioning and evolution

- Type compatibility is not data compatibility: a message persisted by an older deployment may fail a new schema that type-checks.
- Queues declare a `schemaVersion`; `holqa.message/1` envelopes carry it. Fingerprints (`fingerprintSchemaContract`) exclude the version and the source library.
- `checkSchemaCompatibility` classifies changes by role (`message`, `request`, `response`) and direction. Breaking changes without a version increase are `HOLQA_SCHEMA_CHANGE_BREAKING` errors; with one, `HOLQA_SCHEMA_MIGRATION_REQUIRED` warnings.
- The evolution guidance table in the reference is pinned by `packages/compiler/tests/schema/compatibility.test.ts`. Change both together.
- A migration engine is not implemented; do not build one without an accepted design.

### 4. Canonical JSON

Use `canonicalJsonStringify` for every artifact that must be deterministic (manifests, fingerprints, golden test files):

- Keys sorted by UTF-16 code unit at every depth; array order preserved.
- Two-space indent, `\n` line endings, no trailing newline; `-0` becomes `0`.
- Throws `CanonicalJsonError` for `undefined`, functions, symbols, `bigint`, `NaN`/`Infinity`, non-plain objects (`Date`, `Map`, class instances), and cycles. The error's `.diagnostic` has code `HOLQA_MANIFEST_NOT_SERIALIZABLE` and the message includes the JSON path (for example `$.resources[0].id`).
- It is not RFC 8785 (JCS): output is indented and number formatting follows `JSON.stringify`. Do not describe it as JCS.
- Convert values to plain JSON before serializing (for example ISO strings for dates); never patch the serializer to accept new types silently.

See [references/canonical-json-and-diagnostics.md](references/canonical-json-and-diagnostics.md).

### 5. Diagnostic codes

Codes are public, versioned contract. The registry in `packages/core/src/diagnostics/codes.ts` and [docs/reference/diagnostic-codes.md](../../../docs/reference/diagnostic-codes.md) list every current code, including the `HOLQA_SCHEMA_*` and `HOLQA_PAYLOAD_*` codes. Keys of a diagnostic's `details` are documented per code and are contract too.

To add one:

1. Add a camelCase key and `HOLQA_<AREA>_<PROBLEM>` value with a JSDoc comment to `diagnosticCodes` in `packages/core/src/diagnostics/codes.ts`.
2. Emit it with `createDiagnostic({ code, severity, message, hint? })`. `error` severity must fail the operation; `warning`/`info` must not.
3. Test that the code is produced (assert `code`, not the full message).
4. Document it in [docs/reference/diagnostic-codes.md](../../../docs/reference/diagnostic-codes.md).

Never rename, remove, or reuse a code for a new meaning. Never put secrets or environment values in messages or hints.

## Examples

A resource definition (implemented in `@holqa/sdk`):

```ts
orders: queue({
  id: "order-processing",
  message: z.object({ orderId: z.string(), priority: z.enum(["normal", "urgent"]) }),
  schemaVersion: 1,
  delivery: { maxAttempts: 5, deadLetter: true }
});
```

Real, runnable code today:

```ts
import { canonicalJsonStringify } from "@holqa/compiler";
import { parseResourceId } from "@holqa/core";

const id = parseResourceId("order-processing");
canonicalJsonStringify({ kind: "queue", id: id.ok ? id.value : null });
// '{\n  "id": "order-processing",\n  "kind": "queue"\n}'
```

## Verification checklist

- [ ] No unvalidated cast to `ResourceId`; untrusted input enters as `unknown`.
- [ ] Every rejection path has a test asserting the diagnostic code (and JSON path for serialization).
- [ ] Determinism tests: insertion-order independence, no timestamps, paths, or randomness in output.
- [ ] No schema library or provider type imported into `core`.
- [ ] Diagnostic codes only added, never renamed; reference doc updated.
- [ ] Compatibility impact (identity, persisted data, fingerprints) stated in the summary.
- [ ] `pnpm turbo run test typecheck --filter=...@holqa/core` and `pnpm check` pass.

## References

- Standard Schema: https://standardschema.dev
- Zod: https://zod.dev, JSON Schema conversion: https://zod.dev/json-schema
- Valibot: https://valibot.dev; Effect Schema: https://effect.website/docs/schema/introduction/
- JSON Schema: https://json-schema.org; RFC 8785 (for contrast): https://www.rfc-editor.org/rfc/rfc8785
- Local: [docs/concepts/type-safety-and-schemas.md](../../../docs/concepts/type-safety-and-schemas.md), [docs/reference/diagnostic-codes.md](../../../docs/reference/diagnostic-codes.md), [ADR 0004](../../../docs/architecture/decisions/0004-stable-logical-resource-identities.md), [ADR 0016](../../../docs/architecture/decisions/0016-schema-adapters-and-conversion-fidelity.md), [docs/architecture/compiler.md](../../../docs/architecture/compiler.md)
- Related skills: `holqa-architecture`, `typescript-library`, `safe-refactoring`
