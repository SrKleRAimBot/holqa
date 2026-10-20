# 0034. Provisioning separate from runtime bindings

- **Status:** Proposed
- **Date:** 2026-10-20
- **Deciders:** Holqa maintainers
- **Refines:** [ADR 0029](0029-binding-provider-protocol-and-versioned-contracts.md), [ADR 0033](0033-deployment-artifacts-and-binding-manifests.md).

> **Implementation status:** Implemented in `@holqa/core` (the provisioner protocol types), `@holqa/bindings` (`defineProvisioning`, `planProvisioning`, `applyProvisioning`), `@holqa/rabbitmq` (`rabbitmq.provisioner`), `@holqa/s3` (`s3.provisioner`) and `@holqa/cli` (`holqa provision plan`, `holqa provision apply`).

## Context

Runtime providers connect to infrastructure that exists and need only data-plane permissions. Someone still has to create queues, buckets, exchanges and notification rules. Teams use Terraform, Pulumi, scripts or manual steps, and all of these must stay valid. Where Holqa helps, it must not give runtime processes administrative permissions, must not silently destroy data, and must not grow into a general infrastructure-as-code tool.

## Decision

1. **A separate protocol.** A `Provisioner` (`provisioningProtocol: 1`) is side-effect-free data plus `supports`, `plan` and `apply`. It declares its own credential references, typically administrative ones the runtime never receives, and can resolve only those.
2. **Derived from the runtime binding.** A provisioner claims resources bound to runtime providers it understands and derives the infrastructure from those providers' settings (names, prefixes, delay queues, event channels) and the application's handlers. The runtime and provisioning therefore cannot disagree about names.
3. **Classified plans.** `plan` only reads and returns changes with an action: `create`, `update` (in place, without data loss), `replace` (delete and recreate, destructive), `delete` (destructive) or `none`. Each change has a type, a physical target, the resource it serves and a reason. Resources no provisioner claims are listed as unprovisioned: they must exist. Two provisioners managing one target is an error.
4. **No implicit destruction.** Provisioners plan only for declared resources, so removing a declaration never plans a deletion; deleting infrastructure is an operator action outside the protocol. `applyProvisioning` plans again, applies nothing when the plan has errors or a destructive change without explicit authorization (`HOLQA_PROVISIONING_DESTRUCTIVE`), and stops at the first failure, reporting what was applied.
5. **Reference provisioners.** The RabbitMQ provisioner declares queue topologies, the notification exchange and subscription queues and their bindings. The S3 provisioner creates buckets and maintains one notification rule it owns, keeping other rules. Bucket policies are never changed.
6. **The CLI runs provisioning in a separate process with the full environment.** Analysis keeps its allowlisted environment; only `holqa provision` receives administrative credentials.

## Consequences

### Positive

- Infrastructure created any other way remains first-class; provisioning is optional.
- Plans can be reviewed (and stored as JSON) before anything changes.

### Negative

- AMQP 0-9-1 cannot read bindings, so the RabbitMQ provisioner plans existing bindings as idempotent `update`s.
- There is no state file: orphaned infrastructure is not detected.

### Revisit when

- Drift detection or orphan reporting is needed, or provisioners need ordering across each other.

## Alternatives considered

### Provisioning inside runtime providers

Rejected: runtime processes would need administrative permissions, and starting an application could change infrastructure.

### A general infrastructure-as-code engine

Rejected: Terraform and Pulumi exist; Holqa only needs the infrastructure its own providers derive.

## Related

- [Provisioning reference](../../reference/provisioning.md)
