# @holqa/compiler

Transforms a Holqa application's declarations and handlers into a deterministic, versioned, infrastructure-neutral
manifest with structured diagnostics.

> **Status:** Handler discovery, graph validation, manifest version 1, the entry point map, the resource graph and
> schema contracts (normalization, fingerprints, compatibility checks) are implemented. Client generation, bundling of
> executable artifacts and comparison with a deployed manifest are planned. Private and unpublished.

The compiler is deliberately separate from the runtime ([ADR 0007](../../docs/architecture/decisions/0007-separate-compiler-and-runtime.md))
and runtime-neutral: it never loads code. A host (the `holqa` CLI) evaluates the application module and the handler
modules, which runs their code, and passes the results in. The normative format and rules are in the
[compiler specification](../../docs/reference/compiler-specification.md).

## Compiling an application

```ts
import { compileApplication, serializeManifest } from "@holqa/compiler";

const result = await compileApplication({
  app, // the default export of infra.ts
  appModule: "infra.ts",
  modules, // [{ path: "src/orders/process.handler.ts", exports: { ... } }]
  runtime: "bun",
  adapters: [zodAdapter]
});
if (result.ok)
  console.log(serializeManifest(result.manifest));
else
  console.error(result.diagnostics);
```

`result.ok` is `false` when any diagnostic is an error; no manifest is produced then. Every problem is reported at
once: duplicate identifiers, references to undeclared resources, trigger mismatches, a second queue consumer,
conflicting routes, unknown settings and unsupported schemas.

| Export | Description |
| --- | --- |
| `compileApplication(input)` | Compiles an evaluated application into a manifest and entry point map. |
| `selectHandlerModules`, `compileGlob`, `discoverHandlers` | Handler discovery with host-independent glob semantics. |
| `serializeManifest`, `serializeEntrypoints`, `fingerprintManifest` | Canonical JSON and the manifest fingerprint. |
| `validateManifest`, `validateEntrypoints` | Readers for untrusted documents. |
| `manifestJsonSchema`, `entrypointsJsonSchema` | The formats, also published as `@holqa/compiler/manifest-v1.schema.json` and `@holqa/compiler/entrypoints-v1.schema.json`. |
| `buildResourceGraph(manifest)` | Nodes and declared relationships. |

## Canonical JSON

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

## Schema contracts

| Export | Description |
| --- | --- |
| `normalizeSchema(schema, { subject, adapters })` | Converts a Standard Schema into a canonical `SchemaContract` through a library adapter, or reports `HOLQA_SCHEMA_UNSUPPORTED`. |
| `describeSchemaContract(schema, { subject, schemaVersion, adapters })` | Normalizes and fingerprints a schema into a versioned `SchemaContractRecord`. |
| `canonicalizeJsonSchema(schema)` | Sorts set-like JSON Schema keywords so that equivalent schemas become identical. |
| `fingerprintSchemaContract(contract)` | `sha256:` fingerprint of a contract's wire-relevant parts. |
| `checkSchemaCompatibility(previous, next, { role, subject })` | Classifies every change for a `message`, `request` or `response` contract and reports breaking changes. |

See [schema contracts](../../docs/reference/schema-contracts.md) and the [packages reference](../../docs/reference/packages.md#holqacompiler).
