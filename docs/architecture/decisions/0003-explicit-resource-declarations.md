# 0003. Explicit, declarative resource declarations

- **Status:** Accepted (foundational principle, not implemented)
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

> **Implementation status:** No part of this decision is implemented. `@holqa/sdk`, `defineApp` and the resource constructors shown below do not exist. The code is illustrative and the API may change.

## Context

Holqa's central abstraction is the [application resource graph](../../concepts/resource-graph.md): HTTP APIs, queues, buckets, schedules, secrets and static sites, the handlers that use them, and the relationships between them. Tools (the future compiler, local runtime, provider bindings and coding agents) have to be able to find that graph reliably.

Frameworks commonly use one of three approaches:

1. **Implicit discovery.** Infrastructure is inferred from how code is used, for example a queue exists because some handler calls `send`.
2. **Imperative provisioning.** Code calls APIs that create infrastructure when it runs.
3. **Explicit declarations.** Data-like definitions in a known place.

Implicit discovery makes the graph depend on code paths and makes accidental resource creation (or deletion) easy. Imperative provisioning mixes deployment side effects into application code and makes static analysis unsafe. Holqa needs a graph that can be read deterministically, validated before anything runs, and reviewed in a diff.

## Decision

Holqa applications **declare their resources explicitly and declaratively**:

- A conventional entry point, `infra.ts`, is the application's resource registry. Registries may be composed from several files, but the composed result is one explicit graph.
- Declarations describe *what* is required (identity, contract, delivery guarantees), never *how* to provision it. Calling a declaration function provisions nothing and performs no I/O.
- Declarations must be deterministic and free of uncontrolled side effects, so that analysing them twice gives the same result.
- Business logic lives in separate handler modules that reference declared resources through typed handles. Handlers do not declare infrastructure.
- Removing a declaration does not by itself authorize deleting physical infrastructure. Destructive changes need an explicit, separate decision by the user or provider.
- Persistent resource lifecycles are independent of individual handler lifecycles.

Illustrative only (not implemented):

```typescript
// infra.ts (illustrative, proposed API)
import { defineApp, queue } from "@holqa/sdk";
import { z } from "zod";

export default defineApp({
  name: "commerce",
  resources: {
    orders: queue({
      id: "order-processing",
      message: z.object({ orderId: z.string() }),
      schemaVersion: 1
    })
  }
});
```

## Consequences

### Positive

- The resource graph can be read without executing handlers, which is what the future compiler, `holqa inspect` (proposed) and agents need.
- Changes to infrastructure requirements show up as reviewable diffs in one place.
- Separating declarations from handlers keeps business logic independent of infrastructure bindings.
- Missing or duplicate resources can be reported before deployment.

### Negative

- More ceremony than implicit discovery: a resource has to be declared before it is used.
- Restricting declarations to deterministic, side-effect-free code limits what users can compute inside `infra.ts`. The exact restrictions, and how the compiler loads `infra.ts` safely, are not designed yet (see [ADR 0007](0007-separate-compiler-and-runtime.md) and [security](../../concepts/security.md)).
- Registries composed across files need clear merge rules and duplicate detection. Those are not designed yet.

## Alternatives considered

### Infer resources from handler usage

Rejected. The graph would depend on reachable code, make removing or renaming resources ambiguous, and make accidental infrastructure changes likely.

### Imperative infrastructure code (infrastructure-as-code inside the app)

Rejected for the application model. Tools such as Pulumi or Terraform are suitable for provisioning, and a future provisioning provider may delegate to them. Holqa declarations describe logical requirements and leave provisioning to a separate, optional layer ([ADR 0005](0005-infrastructure-independent-resource-contracts.md)).

### Decorators or file-system conventions only

Rejected as the primary mechanism. Decorators tie declarations to classes and hide the graph across files. Pure file-system conventions cannot express contracts and guarantees. Handler discovery by glob (for example `handlers: ["./src/**/*.handler.ts"]`) may complement explicit declarations but does not replace them.

## Related

- [Application model](../../concepts/application-model.md)
- [Resource graph](../../concepts/resource-graph.md)
- [ADR 0004: Stable logical resource identities](0004-stable-logical-resource-identities.md)
- [ADR 0007: Separate compiler and runtime](0007-separate-compiler-and-runtime.md)
- [Status model](../status-model.md)
