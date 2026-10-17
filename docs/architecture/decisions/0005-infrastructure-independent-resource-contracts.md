# 0005. Infrastructure-independent resource contracts

- **Status:** Proposed
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

> **Implementation status:** Proposed design. Nothing in this ADR is implemented: there are no resource contracts, runtime drivers, provisioning providers or capability checks in the repository. The three-layer split needs validation by implementing at least the local provider and one external provider before the ADR can be accepted.

## Context

Holqa is meant to be infrastructure-agnostic: an application should be able to run against self-managed infrastructure, existing infrastructure, third-party services, or a local emulator, without changes to its business logic. Infrastructure services differ in real ways, though:

- Queues differ in delivery guarantees (at-least-once and exactly-once claims, ordering), retry and backoff control, dead-letter support, and maximum message size.
- Object stores differ in event notification support, signed URL semantics and consistency.
- Schedulers differ in timezone support and overlap handling.

A lowest-common-denominator API hides those differences until production. Provider-specific options added to core types ("config bags") couple applications to one vendor. Combining runtime access with provisioning also means a running application would need permission to create and delete infrastructure, which it should not have.

## Decision (proposed)

Separate infrastructure concerns into three responsibilities:

1. **Resource contract (provider-independent).** A logical resource declares its identity, data contract and *required behaviour*: for example "at-least-once delivery, up to 5 attempts, dead-letter required" or "object-created events required". The core model contains no provider-specific configuration bags.
2. **Runtime driver.** Implements resource operations at run time (send, consume, get, put). It needs only data-plane permissions and must never require provisioning permissions.
3. **Provisioning provider (optional).** Creates and reconciles physical infrastructure for a set of contracts. It can be omitted entirely when infrastructure is managed elsewhere.

**Capability negotiation.** Each binding advertises its capabilities. Holqa compares a resource's required behaviour with the selected binding's capabilities and **fails explicitly** with a structured diagnostic when a requirement cannot be met. Unsupported semantics are never silently ignored or downgraded.

**Environment-specific bindings.** The same contract can be bound to different drivers in different environments, for example the local emulator in development and an external queue service in production.

**Local provider first.** A local driver (planned `@holqa/local`) is the first binding, so applications can run without cloud credentials. It must not claim stronger guarantees than production drivers provide.

## Consequences

### Positive (expected)

- Business logic and contracts do not depend on any vendor.
- Semantic differences surface as diagnostics before deployment rather than as incidents in production.
- Least privilege: running applications do not hold provisioning credentials.
- Users with existing infrastructure can use Holqa without a provisioning provider.

### Negative (expected)

- A capability vocabulary is hard to design: too coarse and it hides real differences, too fine and every provider reports partial support. This is the main reason the ADR is still Proposed.
- Users who need provider-specific features will need a documented escape hatch that does not pollute the core model. That escape hatch is not designed.
- Three layers mean more packages and interfaces to maintain.

### Validation needed before acceptance

- Implement the local driver and at least one external queue driver against the same contract.
- Show that capability mismatches produce clear diagnostics.
- Design and test the escape hatch for provider-specific options.

## Alternatives considered

### Lowest-common-denominator portable API

Rejected. It hides semantic differences, which is exactly the failure Holqa wants to prevent.

### Provider-specific configuration inside core resource types

Rejected. It couples every application and the core model to particular vendors and grows without bound.

### Delegate everything to an existing infrastructure-as-code tool

Rejected as the *contract* layer, because such tools describe physical resources rather than logical requirements. They remain a credible implementation strategy for a future provisioning provider.

### Single provider object handling both runtime access and provisioning

Rejected. It forces runtime processes to hold provisioning permissions.

## Related

- [Infrastructure providers](../../concepts/infrastructure-providers.md)
- [Local development](../../concepts/local-development.md)
- [Security](../../concepts/security.md)
- [ADR 0003: Explicit resource declarations](0003-explicit-resource-declarations.md)
- [ADR 0007: Separate compiler and runtime](0007-separate-compiler-and-runtime.md)
