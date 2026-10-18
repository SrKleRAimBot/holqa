---
"@holqa/core": minor
"@holqa/compiler": minor
"@holqa/sdk": minor
"@holqa/zod": minor
---

Add the schema system and contract compatibility checks.

- `@holqa/core`: structured validation issues (`segments`, `pointer`, scalar `details`) and an optional `details` field on `Diagnostic` (copied and deeply frozen); JSON wire payloads (`toWirePayload`, `prepareWirePayload`, `encodeJsonPayload`, `decodeJsonPayload`, `PayloadError`); versioned `holqa.message/1` envelopes and `createMessageCodec`; `PayloadCodec` with JSON and bytes codecs; the `SchemaAdapter` contract and Standard JSON Schema types; eleven new diagnostic codes (`HOLQA_SCHEMA_*`, `HOLQA_PAYLOAD_*`).
- `@holqa/compiler`: `normalizeSchema`, `describeSchemaContract`, `canonicalizeJsonSchema`, `fingerprintSchemaContract` and `checkSchemaCompatibility`. Additive.
- `@holqa/zod` (new): the Zod 4 schema adapter.

Compatibility:

- **Type change:** `ValidationIssue` gains the required fields `segments` and `pointer`. Reading issues is unaffected, and the `InputValidationError` constructor still accepts `{ message, path }` issues (now typed `ValidationIssueInit`). Code that builds or implements `ValidationIssue` values itself must add the two fields or use `ValidationIssueInit`.
- **Behavior change in `@holqa/sdk`:** `queue(...).send` now converts the message to an exact JSON copy, validates that copy, and passes the copy to the driver.
  - Values without a JSON form (for example a `Date` accepted by `z.unknown()`, `NaN`, a `Map`) now fail with `HOLQA_PAYLOAD_NOT_SERIALIZABLE` instead of reaching the driver.
  - Properties whose value is `undefined` are omitted before validation, so a schema that requires such a key (for example `z.object({ a: z.undefined() })`) now fails with `HOLQA_INPUT_INVALID`.
  - Drivers receive a copy rather than the caller's object.

  Migration: send JSON data in the schema's input form (ISO strings rather than `Date`s), and mark keys that may be absent as optional.
