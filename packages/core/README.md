# @holqa/core

Framework-neutral contracts and primitives shared by every Holqa package.

> **Status:** Implemented contracts, private and unpublished. The API may change before the first release.

`@holqa/core` is the innermost package: it depends on no other Holqa package and imports no runtime-specific modules
(`bun`, `node:*`). See [package boundaries](../../docs/architecture/package-boundaries.md).

## Contents

| Export | Purpose |
| --- | --- |
| `Result`, `Ok`, `Err`, `ok()`, `err()` | Discriminated union for expected, recoverable failures. |
| `Diagnostic`, `createDiagnostic()`, `formatDiagnostic()` | Structured, JSON-compatible problem reports. |
| `diagnosticCodes`, `DiagnosticCode` | Registry of stable `HOLQA_*` codes ([reference](../../docs/reference/diagnostic-codes.md)). |
| `ResourceId`, `parseResourceId()`, `isResourceId()`, `maxResourceIdLength`, `checkIdentities()` | Validation of stable logical resource identifiers, individually and as a unique set. |
| `HolqaError`, `failWith()`, `isHolqaError()`, `diagnosticsOf()` | Errors that carry diagnostics, recognized across package copies. |
| `StandardSchemaV1`, `InferInput`, `InferOutput`, `isStandardSchema()`, `validateInput()`, `InputValidationError` | Standard Schema contracts and validation of untrusted input, with per-field issues (`path`, `pointer`, `segments`, `details`). |
| `toWirePayload()`, `prepareWirePayload()`, `encodeJsonPayload()`, `decodeJsonPayload()`, `PayloadError` | The JSON wire format: exact copies, validated after encoding, with paths for anything that has no JSON form. |
| `createMessageCodec()`, `encodeMessageEnvelope()`, `decodeMessageEnvelope()` | Versioned `holqa.message/1` envelopes validated with one schema on both ends. |
| `PayloadCodec`, `jsonPayloadCodec`, `bytesPayloadCodec` | Explicit codecs for JSON and binary payloads. |
| `SchemaAdapter`, `SchemaSideDescription`, `RuntimeOnlyConstraint`, `hasStandardJsonSchema()` | The contract schema-library adapters implement. |
| Descriptor protocol: `AppDescriptor`, `ResourceDescriptor`, `HandlerDescriptor`, `ConfigDescriptor`, `getDescriptor()` and friends | What the SDK writes and compilers and runtimes read. |
| `ResourceKindMap`, `TriggerKindMap` | Typed registries of resource kinds (`queue`, `bucket`, `schedule`, `http.api`) and trigger kinds (including `http.route` and `http.procedure`). |
| `RuntimeBinding`, `bindApp()`, `resolveDriver()`, `readConfig()`, `checkCapabilities()` | How logical resources resolve to drivers at run time. |
| `HttpInvocationInput`, `HttpRejectedError`, `HttpErrorBody`, `rpcProtocolFormat`, `RpcResponseEnvelope`, ... | HTTP and `holqa.rpc/1` wire contracts shared by the SDK, runtimes and future clients. |
| `ApplicationScope`, `ScopedDefinition` | The application execution context that invocations share. |

```ts
import { formatDiagnostic, parseResourceId } from "@holqa/core";

const result = parseResourceId("Orders");
if (!result.ok)
  console.error(formatDiagnostic(result.error));
// error HOLQA_RESOURCE_ID_INVALID: Resource identifier "Orders" is invalid.
//   hint: Use lowercase letters and digits, start with a letter, and separate segments with a single "-" or ".".
```

Applications are declared with [`@holqa/sdk`](../sdk/README.md); the internal model is described in
[resource model](../../docs/architecture/resource-model.md). Schema normalization lives in [`@holqa/compiler`](../compiler/README.md)
and the first adapter in [`@holqa/zod`](../integrations/zod/README.md); see
[schema contracts](../../docs/reference/schema-contracts.md).

## Development

```bash
pnpm --filter @holqa/core build
pnpm --filter @holqa/core test
```
