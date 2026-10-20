---
"@holqa/cli": minor
"@holqa/local": minor
"@holqa/testing": minor
---

Run local development and tests through the binding layer.

- `@holqa/cli`: every `holqa dev` generation composes its binding with `@holqa/bindings`: the local platform on the state directory by default, or the configuration exported by `--bindings <path>`. The configuration is resolved and validated against the handlers before a reload replaces the running generation; changing the bindings module restarts the application (restart reason `bindings`). Operations that need local state act on the configuration's local providers, or fail with `HOLQA_LOCAL_OPERATION_FAILED` when it selects none.
- `@holqa/local`: `createLocalEnvironment({ persistence: "memory" })`; `localStateOf(provider)` reaches the state behind a local provider.
- `@holqa/testing`: `createTestApp({ persistence: "memory" })`; `withFaults(provider, faults)` injects classified open, readiness, operation, receive, lease and stop failures, latency and health into any provider.
