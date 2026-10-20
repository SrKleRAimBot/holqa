---
"@holqa/core": minor
"@holqa/compiler": patch
"@holqa/sdk": minor
"@holqa/bindings": minor
"@holqa/cli": minor
---

Negotiate capabilities between resources and the providers selected for them.

- `@holqa/core`: `requiredCapabilities` and `providedCapabilities` name both sides in the required-capability vocabulary; `QueueCapabilities.maxMessageBytes`; `HOLQA_BINDING_TOPOLOGY_UNSUPPORTED`.
- `@holqa/compiler`: derives `requiredCapabilities` through `@holqa/core`; manifests are unchanged byte for byte.
- `@holqa/sdk`: queue sends and signed URLs check the limits of the provider selected for the resource (`resourceBindingInfo`) instead of the binding's kind-level capabilities, so composed bindings apply each provider's own limits; sends larger than `maxMessageBytes` fail with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`. Behaviour with single, non-composed bindings is unchanged.
- `@holqa/bindings`: `validateBindings` (requirements, trigger delivery, topology, execution limits, event safety stores) and `inspectBindings` (the `holqa.bindings/1` report with native, emulated and unsupported requirements). `environmentConfig()` records `settings.source`.
- `@holqa/cli`: `holqa bindings inspect`, `holqa bindings validate` (including a credential check for environment-backed configuration) and `holqa inspect --capabilities [--bindings <path>]`. `CliHost.analyze` takes optional `AnalyzeOptions`, and `CliHost.environment` is new; both are optional, so existing hosts keep working.
