# @holqa/core

Framework-neutral contracts and primitives shared by every Holqa package.

> **Status:** Implemented foundations, private and unpublished. The API may change before the first release.

`@holqa/core` is the innermost package: it depends on no other Holqa package and imports no runtime-specific modules
(`bun`, `node:*`). See [package boundaries](../../docs/architecture/package-boundaries.md).

## Contents

| Export | Purpose |
| --- | --- |
| `Result`, `Ok`, `Err`, `ok()`, `err()` | Discriminated union for expected, recoverable failures. |
| `Diagnostic`, `createDiagnostic()`, `formatDiagnostic()` | Structured, JSON-compatible problem reports. |
| `diagnosticCodes`, `DiagnosticCode` | Registry of stable `HOLQA_*` codes ([reference](../../docs/reference/diagnostic-codes.md)). |
| `ResourceId`, `parseResourceId()`, `isResourceId()`, `maxResourceIdLength` | Validation of stable logical resource identifiers. |

```ts
import { formatDiagnostic, parseResourceId } from "@holqa/core";

const result = parseResourceId("Orders");
if (!result.ok)
  console.error(formatDiagnostic(result.error));
// error HOLQA_RESOURCE_ID_INVALID: Resource identifier "Orders" is invalid.
//   hint: Use lowercase letters and digits, start with a letter, and separate segments with a single "-" or ".".
```

The resource model (`defineApp`, resource definitions, schema normalization) is planned; see the
[roadmap](../../docs/roadmap.md).

## Development

```bash
pnpm --filter @holqa/core build
pnpm --filter @holqa/core test
```
