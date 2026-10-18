---
paths:
  - "packages/core/**"
  - "packages/compiler/**"
  - "packages/sdk/**"
  - "packages/integrations/**"
---

# Schema and serialization safety

- Validate every untrusted value at the boundary where it enters (config, messages, HTTP input, files). Accept `unknown`, return `Result<T, Diagnostic>` or a typed error with a diagnostic. TypeScript types are not runtime validation.
- Resource identity is an explicit `ResourceId`, never a TypeScript property name. Construct it only via `parseResourceId`; do not cast strings to `ResourceId` outside that function.
- Do not change the resource ID grammar (`^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`, max 63 chars) without an ADR update; changing it can invalidate persisted identities.
- Serialize anything that must be reproducible (manifests, fingerprints, golden files) with `canonicalJsonStringify` from `@holqa/compiler`, never `JSON.stringify` directly. It sorts keys, normalizes `-0`, and throws `CanonicalJsonError` instead of dropping data.
- Never silently drop, coerce, or default data during serialization or normalization. Unsupported values must produce an explicit diagnostic.
- A schema that cannot be faithfully normalized (for example transforms with no JSON Schema equivalent) must produce a diagnostic, not a lossy approximation.
- Design schema contracts around the Standard Schema interface. Do not make core generics depend on Zod; Zod support belongs in the dedicated `@holqa/zod` integration.
- Values crossing an execution boundary are JSON in their schema's input form. Encode with `prepareWirePayload`, which converts to an exact JSON copy and validates that copy; never send a schema's output or the caller's object.
- Treat diagnostic codes in `packages/core/src/diagnostics/codes.ts` as public contract: add new codes, never rename, remove, or reuse an existing one. Document each new code in `docs/reference/diagnostic-codes.md`.
- Keep output deterministic: no timestamps, random values, absolute paths, environment data, or `Map`/`Set` iteration order in serialized artifacts.
- Never place secrets, credentials, or environment values in manifests, diagnostics, or generated clients.
- Add tests for every new rejection path (assert the diagnostic `code` and, for serialization, the JSON path) and for determinism (insertion-order independence).

See the `resource-contracts` skill and [ADR 0006](../../docs/architecture/decisions/0006-standard-schema-and-portable-schema-representation.md).
