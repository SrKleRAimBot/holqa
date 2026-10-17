---
"@holqa/core": minor
"@holqa/sdk": minor
"@holqa/testing": minor
---

Add the core application and resource model.

- `@holqa/core`: the `~holqa` descriptor protocol with typed resource and trigger kind registries (`queue`, `bucket`, `schedule`, `http.api`), handler definitions separated from `invoke`, structural descriptor readers, Standard Schema types and `validateInput`, `HolqaError`, `checkIdentities`, the `RuntimeBinding` contract with `bindApp`, `resolveDriver` and `checkCapabilities`, and six new diagnostic codes (`HOLQA_RESOURCE_ID_DUPLICATE`, `HOLQA_DECLARATION_INVALID`, `HOLQA_INPUT_INVALID`, `HOLQA_RUNTIME_NOT_BOUND`, `HOLQA_RUNTIME_ALREADY_BOUND`, `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`). Additive; no existing export changed.
- `@holqa/sdk` (new): `defineApp`, `defineResources`, `composeResources`, `queue`, `bucket`, `schedule`, `http.api`, `secret`, `variable`, typed handles and handler registration, with compile-time identifier and duplicate checks.
- `@holqa/testing` (new): compile-time type assertions.
