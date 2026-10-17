# @holqa/compiler

Transforms a Holqa application's declarations and handlers into a deterministic, infrastructure-neutral manifest,
executable artifacts, generated clients, and structured diagnostics.

> **Status:** Only the serialization foundation is implemented. Resource analysis, handler discovery, manifest
> generation, and client generation are planned. Private and unpublished.

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
