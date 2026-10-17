# 0017. Package layers after M0

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers (package boundaries approved by the repository owner on 2026-10-17)

> **Implementation status:** The dependency table for existing and planned framework packages is **Implemented** (enforced by `scripts/check-boundaries.ts`) and unchanged by this ADR. The schema-adapter and provider rows are Accepted design, not yet enforced. The M0 experiments are checked against a mirror of the table.

## Context

The bootstrap defined allowed dependencies between framework packages ([package boundaries](../package-boundaries.md)). M0 had to confirm that those directions work in practice before code accumulates, and to specify the layers the bootstrap had not covered: schema adapters, framework adapters, infrastructure drivers and providers, and tools.

M0 built prototypes of the SDK, compiler, runtime and schema adapters as separate workspace packages, checked by the boundary script against a table mirroring the target layering. Findings:

- The compiler and the runtime both worked without importing the SDK, because a shared descriptor protocol sits in the contracts layer ([ADR 0013](0013-descriptor-protocol-in-core.md)).
- The compiler stayed runtime-neutral by receiving evaluated modules from a host. Module loading belongs to the host (CLI), which may depend on both `compiler` and `runtime-bun`.
- Schema adapters needed only the contracts layer.
- `@holqa/core`'s closed `DiagnosticCode` union means every package's diagnostic codes must be registered in core.

## Decision

The allowed internal dependencies are:

| Layer | Packages | May depend on | Enforced? |
| --- | --- | --- | --- |
| Contracts | `@holqa/core` | nothing | Yes |
| Authoring | `@holqa/sdk` | `core` | Yes |
| Client | `@holqa/client` | `core` | Yes |
| Compilation | `@holqa/compiler` | `core` | Yes |
| Execution | `@holqa/runtime-bun` (and future `@holqa/runtime-*`) | `core` | Yes |
| Local environment | `@holqa/local` | `core`, `runtime-bun` | Yes |
| Testing | `@holqa/testing` | `core`, `sdk`, `local`, `runtime-bun` | Yes |
| Tools | `@holqa/cli` | `core`, `compiler`, `local`, `runtime-bun` | Yes |
| Schema adapters | `packages/integrations/{zod,valibot,...}` | `core` only | Not yet (integrations are allowed `core`, `sdk`, `client` today) |
| Framework adapters | `packages/integrations/{orpc,tanstack-query,effect,...}` | `core`, `sdk`, `client` | Yes |
| Infrastructure drivers and provisioning providers | future `packages/providers/*` | `core` only | Not yet (no packages) |
| Experiments | `experiments/*` | the `experimentDependencies` mirror table; never depended on by `packages/*` | Yes |
| Examples | `examples/*` | anything | Yes |

Additional rules:

1. Contracts shared by more than one layer (descriptors, runtime bindings, schema adapters, every diagnostic code) live in `@holqa/core`.
2. The compiler never loads modules; hosts do. Today the only package allowed to host the compiler is `@holqa/cli`. `@holqa/testing` hosts only the runtime. A test utility or Vite plugin that compiles would need a new `compiler` edge, decided separately.
3. Schema adapters are obtained by hosts at run time from the application's own dependencies, never as build-time dependencies of `cli` or `compiler`. The exact discovery mechanism is open (see the [backlog](../../milestones/m0/backlog.md)).
4. Runtime drivers implement the `RuntimeBinding` data-plane contract and must not require provisioning permissions.

## Consequences

### Positive

- The bootstrap's directions are confirmed by working prototypes. No existing package needs a new dependency.
- New layers have decided directions before their first package exists.

### Negative

- `@holqa/core` grows into a contract package and must be reviewed carefully for neutrality.
- Schema adapters lose access to `sdk` and `client`; an adapter that needs them must justify an exception.

### Revisit when

- A schema adapter or provider needs anything beyond `core`.

## Alternatives considered

### Let the compiler load modules itself

Rejected. It would force runtime-specific imports into a neutral package.

### One `integrations` rule for all adapters

Rejected. Schema adapters are used by the compiler's host and should not pull in the SDK or client.

## Related

- [Package boundaries](../package-boundaries.md)
- [M0 experiments](../../../experiments/README.md)
- [ADR 0001: Monorepo tooling](0001-monorepo-tooling-pnpm-turborepo.md)
