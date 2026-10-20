# 0029. A binding provider protocol with versioned contracts

- **Status:** Proposed
- **Date:** 2026-10-20
- **Deciders:** Holqa maintainers
- **Refines:** [ADR 0005](0005-infrastructure-independent-resource-contracts.md), [ADR 0020](0020-runtime-binding-resolution.md), [ADR 0024](0024-event-delivery-sources-and-local-drivers.md). It supersedes none of them.

> **Implementation status:** Implemented in `@holqa/core` (contract versions, the provider protocol, provider validation, failure classification, lifecycle types, per-resource capability resolution). Selecting and composing providers into one binding is [ADR 0030](0030-binding-composition-and-resolution.md).

## Context

[ADR 0020](0020-runtime-binding-resolution.md) gave an application exactly one `RuntimeBinding`, and [ADR 0024](0024-event-delivery-sources-and-local-drivers.md) added delivery sources to it. The only binding is the local one in `@holqa/local`, which fulfils every resource kind at once. That shape cannot express what real deployments need:

- a queue on a message broker, a bucket on S3-compatible storage and the rest on the local platform, each chosen independently;
- a provider that binds only one resource kind (a broker adapter must not be forced to serve HTTP or static files);
- cross-cutting services (configuration and secrets, telemetry export) selected separately from resources;
- explicit knowledge of which version of each contract a provider implements, so a runtime can refuse a provider written for different semantics before it connects;
- validation without credentials or network access, so `holqa bindings validate` and CI can check a deployment;
- a lifecycle (connect, readiness, health, shutdown) that every provider follows the same way, and failures classified so that a transient outage is not reported like a missing bucket.

Constraints: `@holqa/core` stays runtime-neutral; providers depend inward on `@holqa/core` ([package boundaries](../package-boundaries.md)); runtime drivers never need provisioning permissions ([ADR 0005](0005-infrastructure-independent-resource-contracts.md)); existing bindings and their capability checks keep working.

## Decision

1. **Contracts are versioned one by one.** `bindingContracts` in `@holqa/core` lists every binding contract with the version this copy of Holqa implements: the resource contracts `http.api`, `queue`, `bucket`, `bucket.events` and `schedule`, and the non-resource contracts `execution`, `config`, `telemetry`, `idempotency` and `operation-budgets`. A provider declares the version of each contract it implements, and versions must match exactly (`contractVersionProblem`): a version changes only when the meaning of an operation or capability changes in a way an existing provider could violate. `bucket.events` is separate from `bucket` because object storage and its event notifications are often different infrastructure, and a storage provider must not claim events because it can read and write objects.
2. **A provider is side-effect-free data plus `open`.** `BindingProvider` carries a namespaced implementation identifier (`holqa.local`, `example.queue`), an instance `name`, a `role`, the contract versions, the capabilities it advertises per resource kind (the existing `BindingCapabilities` shapes), the services it supplies, optional `execution` capabilities, `emulations`, `topology`, non-secret `settings` and `credentials` (references, never values). Only `open(context)` touches infrastructure, so everything else can be validated, inspected and written to a binding manifest without credentials. `open` returns a `ProviderInstance` that reuses the existing driver and source contracts (`ResourceDrivers`, `ResourceSources`) plus services (`ConfigSource`, telemetry exporters, idempotency and operation budget stores) and lifecycle hooks.
3. **Three roles.** A `platform` provider implements every mandatory contract (`mandatoryBindingContracts`: all except the optional event safety stores) and binds every resource kind; a `resource` provider binds one or more kinds; a `service` provider supplies services and binds no resources. `validateProvider` enforces the declaration in depth: every bound kind and supplied service has its contract and the reverse, capability shapes match the kind registry, object events require `bucket.events`, `execution` capabilities exist exactly with the `execution` contract.
4. **The provider type records what it binds.** `BindingProvider<Kinds, Services>` makes the bound kinds required properties of `resources`, so a binding configuration rejects a bucket provider for a queue at compile time. `AnyBindingProvider` accepts every provider.
5. **Emulation is explicit.** A provider that fulfils a capability its infrastructure lacks (for example delayed redelivery through delay queues on a broker without native delays) lists it in `emulations` with the mechanism and the extra infrastructure it needs, and enables it only when its settings say so. Inspection shows emulated capabilities separately from native ones.
6. **Credentials are references.** `credentialRef(name)` creates `{ type: "credential", name }`; a provider resolves it through `context.credential` when it is opened, which reads the configuration service (environment variables unless another `config` provider is selected). Settings, manifests and diagnostics hold only the name.
7. **Failures are classified.** `bindingFailure(kind, …)` builds a diagnostic with one code per kind: `HOLQA_BINDING_CONFIG_INVALID`, `HOLQA_BINDING_CREDENTIALS_MISSING`, `HOLQA_BINDING_CREDENTIALS_INVALID`, `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` (existing), `HOLQA_BINDING_CONTRACT_INCOMPATIBLE`, `HOLQA_BINDING_UNAVAILABLE` (the only transient one) and `HOLQA_BINDING_FAILED`. Details always carry `binding`, `failure` and `transient`. A provider never falls back to another provider on its own.
8. **One lifecycle.** `BindingLifecycle` has optional `start`, `ready`, `health` and `stop`, called by the runtime that owns the binding in a fixed order (resolve, validate, start, register subscriptions, ready, run, drain, stop). `stop` must be safe after a failed or partial start. `combineHealth` reports the worst component status.
9. **Per-resource capabilities.** `RuntimeBinding` gains an optional `describe(resource)` returning the provider name and capabilities that apply to that resource. `bindApp` and `checkTriggerDelivery` use it (`resourceBindingInfo`), so a composed binding is checked resource by resource and diagnostics name the provider actually selected. Capability diagnostics gain `details` with `resource`, `kind`, `binding` and `requirement`, the unmet capability in the required-capability vocabulary of the [compiler specification](../../reference/compiler-specification.md#required-capabilities).

## Consequences

### Positive

- External providers can be written against small, versioned contracts and validated before they run.
- A deployment can be checked in CI without credentials.
- Diagnostics are machine-readable: tools can tell a missing credential from an outage from an unsupported requirement.
- Existing bindings keep working unchanged: `describe` and the new fields are optional.

### Negative

- Exact version matching means a provider must be released for each contract version change; there is no negotiation of version ranges yet.
- The capability vocabulary is still small. New guarantees (ordering, transactions, message size) need a kind registry change and a contract version decision each.
- Providers are trusted code that runs in the application process; the protocol does not sandbox them.

### Revisit when

- A contract needs a second version while providers for the first still exist, which would justify version ranges.
- A provider needs to advertise capabilities that depend on the resource (for example per-queue limits) rather than on the kind.

## Alternatives considered

### One universal provider interface

Every provider would implement every operation and throw for unsupported ones. Rejected: it hides unsupported behaviour until runtime and forces broker adapters to implement storage and HTTP.

### A single version for the whole binding layer

Rejected: a change to queue semantics would invalidate every storage provider.

### Credentials in provider settings

Rejected: settings are recorded in manifests and shown by inspection; values would leak.

## Related

- [Binding contracts reference](../../reference/bindings.md)
- [Infrastructure providers](../../concepts/infrastructure-providers.md)
- [ADR 0005: Infrastructure-independent resource contracts](0005-infrastructure-independent-resource-contracts.md)
