# 0032. Typed, versioned provider extensions

- **Status:** Proposed
- **Date:** 2026-10-20
- **Deciders:** Holqa maintainers
- **Refines:** [ADR 0029](0029-binding-provider-protocol-and-versioned-contracts.md), [ADR 0030](0030-binding-composition-and-resolution.md).

> **Implementation status:** Implemented in `@holqa/core` (`defineExtension`, extension declarations on providers, `checkExtensions`, `requireExtension`, `findExtension`), `@holqa/sdk` (`defineApp({ extensions })`, `app.extensions`), `@holqa/compiler` (manifest version 1, additive), `@holqa/bindings` (selection, validation, composition) and `@holqa/runtime-bun` (start-time check). The reference extension, `holqa.app-cache`, is implemented by `localAppCache` in `@holqa/local`.

## Context

The portable resource kinds are deliberately small. Infrastructure often offers more (an edge cache, a feature flag client, a search index), and applications want to use it without the kind registry growing for every vendor feature and without giving up type safety or explicit failure.

## Decision

1. **An extension is a contract, not an implementation.** `defineExtension<Api>({ id, version, description?, runtimes?, dependsOn?, config? })` creates a frozen definition with a namespaced identifier (at least two dot-separated segments), a positive whole version, the runtimes and other extensions its implementations need, and a configuration schema implementations validate their settings with. The API type travels as a phantom type.
2. **Applications declare extensions as required or optional.** `defineApp({ extensions: { required, optional } })` records `{ id, version, required }` in the descriptor and, when any are declared, in manifest version 1 (`extensions`, sorted by identifier; applications without extensions keep their bytes). `app.extensions.require(extension)` accepts only required extensions at compile time and returns the typed API; `app.extensions.get(extension)` accepts declared ones and returns the API or `undefined`. Both resolve through the runtime binding when called, never when declared.
3. **Providers implement extensions.** A provider lists `extensions: [{ id, version, dependsOn?, runtimes? }]` and its instance supplies `extensions[id]`. A provider that implements only extensions has the `service` role. Binding configurations select implementations with `defineBindings(app, { extensions: [provider, ...] })`: the first listed provider implementing an extension wins, else the default provider; dependencies are selected the same way.
4. **Failure is explicit.** `validateBindings` and `runtime.start()` report a required extension without implementation (`HOLQA_EXTENSION_MISSING`), an implementation of another version (`HOLQA_EXTENSION_INCOMPATIBLE`; a warning for optional extensions, which are then treated as absent), an unmet dependency, and an implementation for runtimes the execution host does not run. Malformed definitions and declarations are `HOLQA_EXTENSION_INVALID`.
5. **Isolation.** Extension providers are opened and stopped with the binding like every provider. Every provider, extensions included, can resolve only the credentials it declares (`HOLQA_BINDING_CONFIG_INVALID` otherwise), so a binding manifest lists every credential and an extension cannot read another provider's. Importing an extension or a provider package performs no initialization; only `open` does, inside the application's runtime. Provisioning-time extensions are not part of this decision.

## Consequences

### Positive

- Vendor features are usable with full types and explicit capability checks, without changing core resource definitions.
- Optional extensions let applications degrade deliberately rather than by accident.

### Negative

- Extension implementations run in the application process with its permissions; the protocol restricts credentials, not code.
- Exact version matching, as for binding contracts.

### Revisit when

- Extensions need per-resource configuration, or provisioning steps.

## Alternatives considered

### New resource kinds for vendor features

Rejected: every vendor feature would grow the portable model and every provider would have to reject it.

### Untyped service lookup by name

Rejected: loses type safety and versioning.

## Related

- [Binding contracts reference](../../reference/bindings.md#extensions)
- [Application model](../../concepts/application-model.md)
