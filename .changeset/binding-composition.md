---
"@holqa/bindings": minor
"@holqa/core": minor
"@holqa/runtime-bun": minor
---

Compose bindings from several providers.

- `@holqa/bindings` (new): `defineBindings` declares which provider fulfils each resource (by identifier), resource kind and service, type-checked against the application; `resolveBindings` resolves selections deterministically (resource, then kind, then default; never falling through) and reports `HOLQA_BINDING_RESOURCE_UNKNOWN`, `HOLQA_BINDING_KIND_MISMATCH` and `HOLQA_BINDING_MISSING`; `createBinding` composes the result into one `RuntimeBinding` with a lifecycle; `environmentConfig` reads configuration and credentials from environment variables.
- `@holqa/core`: `RuntimeBinding.lifecycle` and `RuntimeBinding.telemetry` (optional), `BindingStartOptions`, `resolveConfiguration`, three new diagnostic codes. `BindingLifecycle.start` takes `{ signal, log }`.
- `@holqa/runtime-bun`: `runtime.start()` starts, readies and (on failure) stops a binding's lifecycle; `runtime.stop()` stops it last, after the final telemetry export (`StopOptions.bindingMs`); `limits.bindingStartMs`; exporters from `RuntimeBinding.telemetry` join the runtime's; `runtime.health()` (`RuntimeHealth`). `createEnvironmentBinding` validates through `resolveConfiguration` with unchanged diagnostics.
