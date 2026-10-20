---
"@holqa/core": minor
"@holqa/sdk": minor
"@holqa/compiler": minor
"@holqa/bindings": minor
"@holqa/runtime-bun": minor
"@holqa/local": minor
---

Add typed, versioned provider extensions.

- `@holqa/core`: `defineExtension<Api>({ id, version, runtimes?, dependsOn?, config? })`; providers declare `extensions` and supply implementations; `RuntimeBinding.extensions`; `checkExtensions`, `requireExtension`, `findExtension`; `AppDescriptor.extensions`; codes `HOLQA_EXTENSION_INVALID`, `HOLQA_EXTENSION_MISSING`, `HOLQA_EXTENSION_INCOMPATIBLE`. A service provider may now supply only extensions.
- `@holqa/sdk`: `defineApp({ extensions: { required, optional } })` and `app.extensions.require` / `get`, typed from the declaration. `App` gains a fourth type parameter with a default.
- `@holqa/compiler`: manifest version 1 records `extensions` when declared (additive; other manifests are unchanged).
- `@holqa/bindings`: `defineBindings({ extensions })` selects implementations; resolution follows dependencies; validation checks versions, dependencies and runtimes. Every provider can now resolve only the credentials it declares in `credentials` (`HOLQA_BINDING_CONFIG_INVALID` otherwise), so undeclared credential reads by providers fail.
- `@holqa/runtime-bun`: refuses to start without a required extension.
- `@holqa/local`: the reference extension `appCacheExtension` (`holqa.app-cache` version 1) and `localAppCache` (`local.appCache`).
