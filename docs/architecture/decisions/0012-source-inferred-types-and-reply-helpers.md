# 0012. Source-inferred types and reply helpers

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

> **Implementation status:** Accepted design, validated by the disposable M0 prototype in [`experiments/sdk`](../../../experiments/sdk/README.md). `@holqa/sdk` is not implemented.

## Context

Holqa's central promise is that a schema declared once in `infra.ts` types every producer and consumer, with no generated types for code that can import the application's source ([type safety and schemas](../../concepts/type-safety-and-schemas.md)). Before the SDK accumulates code, M0 had to establish whether TypeScript 6 can carry exact schema types from `defineApp` through resource handles into separately defined handler modules, and at what cost.

The M0 prototype found that inference works across files, imported schemas, composed resource groups, transforms, defaults, brands and built declarations. Type-checking cost grows linearly with application size: 1.05 s check time for 200 queues, 200 routes and 200 consumers. It also found one hard limitation. When a handler returns an object literal whose expected type depends on a type parameter of the same call, TypeScript widens its literals: `status: 200` becomes `number`, and enum strings become `string`. Seven single-call formulations failed, including `NoInfer`, `const` type parameters and method syntax. Only a two-step builder or a typed `reply(status, body)` helper kept the literals.

## Decision

1. `@holqa/sdk` infers all application types from source. Factories use `const` type parameters for identifiers and structural Standard Schema generics for contracts. Code generation is reserved for consumers that cannot import application source (browser clients, external API consumers).
2. Producers are typed with a schema's **input** type and consumers with its **output** type.
3. Handlers whose return type depends on sibling declarations (HTTP routes, and RPC procedures when designed) build their results through a typed helper in the handler context: `reply(status, body, headers?)`. Returning a literal with `as const` stays supported; returning a plain object literal is not expected to type-check.
4. Resource handles are constrained structurally (`{ kind, id, "~holqa" }`), never by a generic handle type, because handle operations are contravariant in their message types.
5. Graph-level rules that types cannot express (unique identifiers across files, one consumer per queue) are compiler diagnostics.
6. `isolatedDeclarations` is not supported for application modules that declare resources or handlers.

## Consequences

### Positive

- No generated types to keep in sync for server code; editor feedback is immediate.
- Typed handler functions and client contracts can be shared through `import type` (`QueueConsumerFor`, `InferRouteContract`).
- `reply` gives precise errors for undeclared statuses and wrong bodies.

### Negative

- `reply` is one more concept than returning `{ status, body }`, and contradicts some users' expectations from other frameworks.
- Inferred types are only as strict as the schema library's types. Excess-property checks apply only to object literals, and runtime validation remains mandatory.
- Applications cannot use `isolatedDeclarations` for handler modules.

### Revisit when

- A TypeScript release preserves literals in returned object literals under generic contextual types.
- Type-checking cost becomes a measured problem in real applications (track the scale benchmark).

## Alternatives considered

### Two-step builder (`route(declaration).handle(fn)`)

Preserves literals too. Rejected as the default because it splits one declaration across two calls, which the compiler and agents read less directly. It remains the fallback if `reply` proves inadequate for procedures.

### Generated types from a build step

Rejected for server code: it adds a watch step and can drift from the declaration. Kept for browser clients.

### Plain object returns with `NoInfer` or `const` type parameters

Rejected: measured not to preserve literals in TypeScript 6.0.3.

## Related

- [Type inference experiment](../../../experiments/sdk/README.md)
- [API design specification](../../reference/api-design.md)
- [ADR 0006](0006-standard-schema-and-portable-schema-representation.md) and [ADR 0016](0016-schema-adapters-and-conversion-fidelity.md)
