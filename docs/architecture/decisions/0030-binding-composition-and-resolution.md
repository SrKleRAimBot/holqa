# 0030. Binding composition with deterministic resolution

- **Status:** Proposed
- **Date:** 2026-10-20
- **Deciders:** Holqa maintainers
- **Refines:** [ADR 0020](0020-runtime-binding-resolution.md), [ADR 0029](0029-binding-provider-protocol-and-versioned-contracts.md). It supersedes neither.

> **Implementation status:** Implemented in the new `@holqa/bindings` package (`defineBindings`, `resolveBindings`, `createBinding`, `environmentConfig`), `@holqa/core` (`resolveConfiguration`, `RuntimeBinding.lifecycle` and `telemetry`) and `@holqa/runtime-bun` (binding lifecycle, `runtime.health()`).

## Context

[ADR 0029](0029-binding-provider-protocol-and-versioned-contracts.md) defined providers. An application still installs exactly one `RuntimeBinding` ([ADR 0020](0020-runtime-binding-resolution.md)), and the runtime, the SDK's handles and every existing check work against that single binding. Developers need to:

- choose a provider per resource, per resource kind, and a platform default, without touching handlers;
- choose cross-cutting services (configuration and secrets, telemetry) independently of resources;
- get the same selection every time, and errors (not fallbacks) when a selection is wrong;
- connect providers in a predictable order and release them reliably, also after a failed start.

## Decision

1. **A binding configuration is a module.** `defineBindings(app, { name, defaults, kinds, resources, services })` in `@holqa/bindings` is pure, like `defineApp`: it records selections and opens nothing. Resource entries are keyed by resource **identifier**, not alias: identifiers are the persistent identity, and a configuration should survive renaming an alias. It is typed against the application: an undeclared identifier or kind, a provider that does not bind a resource's kind, and (without `defaults`) a resource no entry covers are compile errors.
2. **Resolution precedence is fixed.** A resource gets its `resources` entry, else its kind's `kinds` entry, else `defaults`. A selected provider that does not bind the resource's kind is an error (`HOLQA_BINDING_KIND_MISMATCH`), never a reason to fall through to the next level. An undeclared resource or kind is `HOLQA_BINDING_RESOURCE_UNKNOWN`; a resource without a provider is `HOLQA_BINDING_MISSING`. Results are sorted by identifier and independent of the order entries are written in.
3. **Services resolve separately.** `services.config` is an ordered list of sources (the first that has a value wins); `services.telemetry` exports to every listed provider; `idempotency` and `operation-budgets` take one provider each. A service without an entry uses `defaults` when it supplies the service. Configuration alone has a built-in fallback, `environmentConfig()` (environment variables), so an application always has a configuration source.
4. **Composition produces one runtime binding.** `createBinding(resolveBindings(definition))` returns a `RuntimeBinding` whose drivers and sources dispatch to the provider selected for each resource, whose `describe` reports that provider's capabilities, and whose services forward to their providers. The runtime, the SDK and the existing checks need no knowledge of composition.
5. **The runtime owns the lifecycle.** `RuntimeBinding.lifecycle` (optional) is started by `runtime.start()` after every static check and before the binding is installed, readied after deliveries are registered, and stopped after invocations drained and the final telemetry export, also when the start failed part-way. `limits.bindingStartMs` (default 30 seconds) bounds start and readiness; `stop({ bindingMs })` (default 10 seconds) bounds disposal. `runtime.health()` reports the runtime and the binding's components with a `ready` flag.
6. **Opening order and failure.** A composed binding opens configuration providers first (they cannot use credential references), then other services, then resource providers, each once; credentials resolve through the opened configuration sources. A provider that fails stops the start: the providers already opened are stopped in reverse order and the classified failure is reported; non-Holqa errors become `HOLQA_BINDING_FAILED` with every known credential value removed from the message. A provider that opens without a part it declared (for example a queue driver) is rejected with `HOLQA_BINDING_CONFIG_INVALID`.
7. **Configuration validation is shared.** `resolveConfiguration` in `@holqa/core` applies defaults and validates every entry against its schema, with `HOLQA_CONFIG_INVALID` and no secret values, for the runtime's environment binding and for composed bindings alike.
8. **Telemetry from the binding joins the runtime's.** `RuntimeBinding.telemetry` exporters are added to the runtime's own exporters, under the same bounded pipeline; they are flushed before the binding stops.

## Consequences

### Positive

- Swapping a queue from the local platform to a broker is a one-line change in a binding module; handlers do not change.
- A binding configuration can be checked without connecting (`resolveBindings` reports every problem), so CI can validate deployments.
- No hidden fallbacks: an explicitly selected provider either works or fails with a classified diagnostic.

### Negative

- One more module per environment (`bindings.ts`, or one per environment).
- `@holqa/bindings` types against the structural shape of `defineApp`'s result rather than importing the SDK, to keep it a core-only package; an authoring front end with a different handle shape would need its own typing.
- Telemetry exporters selected through the binding receive nothing recorded before the binding starts.

### Revisit when

- Providers need to be shared between several applications in one process.
- Environments need inheritance (a `staging` configuration derived from `production`).

## Alternatives considered

### Keying resources by alias

Rejected: aliases are local names that may change without changing a resource's identity.

### Falling through to the next precedence level when a provider does not bind a kind

Rejected: a typo in a kind-wide entry would silently move resources to the default provider.

### Letting each provider manage its own lifecycle

Rejected: initialization order, shutdown order and failure handling would differ between providers.

## Related

- [Binding contracts reference](../../reference/bindings.md)
- [Runtime reference](../../reference/runtime.md)
- [ADR 0029: A binding provider protocol with versioned contracts](0029-binding-provider-protocol-and-versioned-contracts.md)
