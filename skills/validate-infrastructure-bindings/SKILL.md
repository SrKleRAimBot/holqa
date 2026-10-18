---
name: validate-infrastructure-bindings
description: Checks that the infrastructure binding chosen for an environment (local runtime, a self-managed service, or a third-party provider) satisfies every requirement declared by a Holqa application's resources, and that unsupported capabilities fail explicitly. Use when selecting or changing a provider, adding a resource requirement, preparing a deployment plan, or investigating a capability mismatch.
license: Apache-2.0
metadata:
  status: preview
---

# Validating infrastructure bindings

> **Preview — mostly not available.** The application manifest is implemented in the Holqa repository (`holqa build --manifest`), including the capabilities each resource requires. Capability validation when a runtime binds an application is implemented: `bindApp` (and therefore `runtime.start()`) fails with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` for every unmet requirement, and the local binding (`@holqa/local`) advertises its capabilities honestly. `holqa doctor` checks the application against the local binding (implemented). Capability validation at build time, doctor checks for other bindings, and bindings for external infrastructure are **accepted design / proposed** and not implemented. No provider exists yet. This skill describes the intended review process.

## When to use

- Choosing infrastructure for an environment (for example local, staging, production).
- Adding a requirement to a resource (dead-lettering, delayed delivery, signed URLs, overlap policies).
- A deployment plan or diagnostic reports an unsupported capability.

## Concepts

Holqa separates three responsibilities:

| Layer | Responsibility |
| --- | --- |
| Resource contract | What the application requires (`infra.ts`). Provider-independent. |
| Runtime driver | Performs operations at runtime (send, consume, get, put). Needs only data-plane permissions. |
| Provisioning provider (optional) | Creates and reconciles physical infrastructure. Needs control-plane permissions. |

Providers do not all offer the same guarantees. A binding must **prove** that it satisfies each declared requirement; anything it cannot satisfy is an error, never silently ignored or approximated.

## Works today

- Resource IDs can be checked against `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$` (at most 63 characters).
- `holqa build --manifest` writes `manifest.json`, whose `requiredCapabilities` and per-resource `requirements` list what a binding must provide. `holqa inspect` prints the same requirements.
- Starting a runtime checks the binding against every declared requirement (delivery, `maxAttempts`, dead-lettering, backoff strategy and delays, access policy, overlap policy) and against every handler's trigger (a queue, object event or schedule handler needs a delivery source); each shortfall is a `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic. Signed URL expiry and send delays are checked when the operation runs.
- `holqa doctor --json` reports a `capabilities` check (with each `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic) and a `configuration` check for the local binding, and exits `1` when a check fails. `holqa build` without `--manifest` reports `HOLQA_CLI_NOT_IMPLEMENTED`.

## Planned workflow

1. **Build the manifest** with `holqa build --manifest` (implemented). It is a deterministic, provider-neutral description of resources and their requirements.
2. **List requirements per resource** — for example, for `order-processing`: at-least-once delivery, 5 attempts with backoff, dead-letter queue, message size limit, consumer concurrency.
3. **Select a binding per environment** and compare each requirement with the binding's declared capabilities.
4. **Run validation** with `holqa doctor` (implemented for the local binding; other bindings proposed). Expect an explicit diagnostic for each unsupported capability.
5. **Resolve mismatches** by choosing another binding or deliberately relaxing the requirement in `infra.ts` — never by hiding provider-specific flags in application code.
6. **Review the plan** a provisioning provider proposes. Creations and updates are listed explicitly; deletions require separate human approval.
7. **Check permissions**: runtime credentials should not include provisioning rights.

Illustrative binding configuration (shape not designed yet):

```ts
// holqa.bindings.ts — illustrative only; the binding API is not designed
export default {
  production: {
    "order-processing": { driver: "example-queue-driver" },
    "customer-uploads": { driver: "s3-compatible", endpoint: process.env.STORAGE_ENDPOINT }
  }
};
```

Example of the intended diagnostic for a mismatch (illustrative; this code is not in the registry yet):

```text
infra.ts:24:5 error HOLQA_CAPABILITY_UNSUPPORTED: Binding "example-queue-driver" for "order-processing" does not support dead-letter queues.
  hint: Choose a binding that supports dead-lettering, or remove `deadLetter: true` deliberately.
```

## Pitfalls

- Assuming local emulation proves production capabilities; the local runtime is one binding among others.
- Adding provider-specific options to resource declarations instead of the binding.
- Granting the runtime provisioning permissions "for convenience".
- Accepting a plan that deletes or replaces a resource because its declaration was removed or its `id` changed.
- Relying on a capability (ordering, exactly-once) that was never declared or validated.

## Verification checklist

- [ ] Every declared requirement is matched to a binding capability, or reported as unsupported.
- [ ] No unsupported capability is silently ignored or emulated.
- [ ] `infra.ts` contains no provider-specific configuration.
- [ ] Runtime and provisioning credentials are separate and least-privilege.
- [ ] Any deletion or replacement in a plan has explicit human approval.
