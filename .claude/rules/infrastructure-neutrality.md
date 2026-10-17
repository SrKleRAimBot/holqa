# Infrastructure neutrality

- Holqa is infrastructure-agnostic. Never add provider-specific types, SDKs, configuration keys, or naming to `core`, `compiler`, `sdk`, or `client`.
- Keep the three concerns separate: resource definitions (what is required), operations and handlers (application behavior), and infrastructure bindings (how a provider or local runtime fulfills requirements).
- Keep runtime drivers separate from provisioning providers. A runtime driver must not require infrastructure-provisioning permissions.
- Do not add arbitrary provider configuration bags (`providerOptions: Record<string, unknown>`) to the core resource model. Logical resources declare required behavior; bindings declare capabilities.
- Unsupported capabilities must fail explicitly with a diagnostic. Never silently ignore or weaken a declared requirement (delivery guarantees, retries, ordering, access policy).
- Do not claim that all providers offer identical semantics. Document semantic differences instead of hiding them.
- The local runtime and emulators must not promise stronger delivery or concurrency guarantees than production bindings.
- The manifest describes logical infrastructure and requirements, never provider-specific physical resources.
- Do not reference or imply any proprietary or first-party hosting product, and do not design APIs around one cloud vendor. When examples need a provider, use neutral wording ("an S3-compatible store", "a message broker") or show more than one.
- Provider and framework integrations depend inward on core abstractions; core never imports them.
- Provider packages and real provisioning are **Planned**, not implemented. Do not scaffold fake providers.

See the `holqa-architecture` skill, [docs/concepts/infrastructure-providers.md](../../docs/concepts/infrastructure-providers.md), and [ADR 0005](../../docs/architecture/decisions/0005-infrastructure-independent-resource-contracts.md).
