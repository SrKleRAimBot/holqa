---
"@holqa/core": minor
---

Add the binding provider protocol and versioned binding contracts.

- `bindingContracts`, `bindingProtocolVersion`, `mandatoryBindingContracts`, `contractVersionProblem`: every binding contract (`execution`, `http.api`, `queue`, `bucket`, `bucket.events`, `schedule`, `config`, `telemetry`, `idempotency`, `operation-budgets`) is versioned on its own; providers must match versions exactly.
- `BindingProvider<Kinds, Services>`, `ProviderInstance`, `ProviderContext`, `ConfigSource`, `ExecutionCapabilities`, `CapabilityEmulation`, `ProviderTopology`, `CredentialReference`, `credentialRef`, `isBindingProvider`, `validateProvider`: side-effect-free provider declarations that can be validated without connecting.
- `bindingFailure`, `isTransientBindingFailure` and six new diagnostic codes (`HOLQA_BINDING_CONFIG_INVALID`, `HOLQA_BINDING_CREDENTIALS_MISSING`, `HOLQA_BINDING_CREDENTIALS_INVALID`, `HOLQA_BINDING_CONTRACT_INCOMPATIBLE`, `HOLQA_BINDING_UNAVAILABLE`, `HOLQA_BINDING_FAILED`) classify binding failures.
- `BindingLifecycle`, `BindingHealth`, `combineHealth`: one lifecycle for every binding.
- `RuntimeBinding.describe` (optional) and `resourceBindingInfo`: per-resource capabilities. `bindApp` and `checkTriggerDelivery` check each resource against the provider selected for it.
- `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostics from `checkCapabilities` and `bindApp` now carry `details` (`resource`, `kind`, `binding`, `requirement`); trigger delivery diagnostics add `binding` and `requirement`. Additive: existing keys are unchanged.
