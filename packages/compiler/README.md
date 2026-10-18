# @holqa/compiler

Transforms a Holqa application's declarations and handlers into a deterministic, infrastructure-neutral manifest,
executable artifacts, generated clients, and structured diagnostics.

> **Status:** The serialization foundation and schema contracts (normalization, fingerprints, compatibility checks) are
> implemented. Resource analysis, handler discovery, manifest generation, and client generation are planned. Private
> and unpublished.

The compiler is deliberately separate from the runtime ([ADR 0007](../../docs/architecture/decisions/0007-separate-compiler-and-runtime.md)).
The intended pipeline is described in [docs/architecture/compiler.md](../../docs/architecture/compiler.md).

## Implemented

`canonicalJsonStringify(value)` serializes data so that semantically equal inputs always produce byte-identical output:
object keys are sorted at every depth, formatting is fixed, and anything without a faithful JSON representation
(`undefined`, functions, bigints, non-finite numbers, class instances, cycles) throws a `CanonicalJsonError` carrying a
`HOLQA_MANIFEST_NOT_SERIALIZABLE` diagnostic with the offending JSON path.

```ts
import { canonicalJsonStringify } from "@holqa/compiler";

canonicalJsonStringify({ kind: "queue", id: "order-processing" });
// {
//   "id": "order-processing",
//   "kind": "queue"
// }
```

### Schema contracts

| Export | Description |
| --- | --- |
| `normalizeSchema(schema, { subject, adapters })` | Converts a Standard Schema into a canonical `SchemaContract` through a library adapter, or reports `HOLQA_SCHEMA_UNSUPPORTED`. |
| `describeSchemaContract(schema, { subject, schemaVersion, adapters })` | Normalizes and fingerprints a schema into a versioned `SchemaContractRecord`. |
| `canonicalizeJsonSchema(schema)` | Sorts set-like JSON Schema keywords so that equivalent schemas become identical. |
| `fingerprintSchemaContract(contract)` | `sha256:` fingerprint of a contract's wire-relevant parts. |
| `checkSchemaCompatibility(previous, next, { role, subject })` | Classifies every change for a `message`, `request` or `response` contract and reports breaking changes. |

See [schema contracts](../../docs/reference/schema-contracts.md).
