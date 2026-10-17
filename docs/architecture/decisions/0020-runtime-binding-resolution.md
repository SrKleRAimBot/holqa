# 0020. Runtime binding resolution

- **Status:** Proposed
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

> **Implementation status:** Implemented in `@holqa/core` by the change that adds this ADR; it becomes Accepted when a maintainer approves it. No runtime, local driver or external driver exists yet; tests use recording bindings.

## Context

A resource handle such as `resources.orders` is declared once in `infra.ts` and imported by handler modules. Declaring it must not open a queue connection or create a storage client, and the same handle must resolve to a local emulator in development, a test double in tests and an external service in production. [ADR 0013](0013-descriptor-protocol-in-core.md) left open where the binding state lives: a mutable slot on the application descriptor, or a core-owned `WeakMap` ([backlog](../../milestones/m0/backlog.md) HB-07). [ADR 0005](0005-infrastructure-independent-resource-contracts.md) requires that unsupported requirements fail explicitly.

## Decision

1. **The binding lives in a slot on the application descriptor** (`AppDescriptor.binding`, a sealed `{ current }` object). It is the only mutable part of a descriptor and is never serialized. A slot, unlike a module-level `WeakMap`, works when the SDK and a runtime load different copies of `@holqa/core`.
2. **A `RuntimeBinding` is data-plane only:** a `name`, advertised `capabilities` by resource kind, `drivers` (factories keyed by resource kind, typed from the kind registry), and `config(entry)`. It must not require provisioning permissions.
3. **`bindApp(app, binding)` checks before it installs.** It rejects an already bound instance (`HOLQA_RUNTIME_ALREADY_BOUND`), and rejects a binding that lacks capabilities for a declared kind, cannot satisfy a declared requirement, or lacks a driver for a kind that has operations, with one `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic per shortfall. Requirements are never weakened.
4. **Handles resolve lazily.** An operation calls `resolveDriver(app, resource, operation)` when it runs; with no binding it fails with `HOLQA_RUNTIME_NOT_BOUND`. Configuration values are read through `readConfig` in the same way.
5. A resource handle belongs to exactly one application instance; `defineApp` records the owner, and every runtime generation evaluates its own `infra.ts` ([ADR 0015](0015-runtime-generations-and-reload.md)).

## Consequences

### Positive

- Importing `infra.ts` has no side effects; analysis tools can load it without credentials.
- Capability mismatches surface when a runtime starts, not on the first message.
- Swapping a local driver for an external one changes only the binding.

### Negative

- Mutable state on a descriptor object, as accepted in ADR 0013.
- One binding per application instance: concurrent bindings of one instance (for example two test harnesses) need two instances.
- Handle ownership (which application a handle belongs to) is recorded in a map private to each copy of `@holqa/sdk`. An application must load a single copy of the SDK; a handle created by another copy fails with `HOLQA_DECLARATION_INVALID` when used. Moving ownership into a slot on the handle would lift this limit.
- Configuration values are typed with each schema's output type, but `readConfig` returns what the binding supplies. Validating values against their schemas (which may be asynchronous) is the binding's responsibility before the application runs; core does not re-validate on each read.
- The capability vocabulary is initial and will change with the first real drivers; ADR 0005 stays Proposed.

### Revisit when

- A runtime needs per-invocation context for handle calls (HB-32).
- Real drivers show that the capability vocabulary is too coarse or too fine.

## Alternatives considered

### Core-owned `WeakMap<AppDescriptor, RuntimeBinding>`

Rejected: keeps descriptors immutable, but two copies of `@holqa/core` would hold two maps, and a handle would not find a binding installed through the other copy.

### Resolve drivers when `defineApp` runs

Rejected: declarations would open connections, and analysis would need credentials.

## Related

- [Resource model architecture](../resource-model.md)
- [Infrastructure providers](../../concepts/infrastructure-providers.md)
