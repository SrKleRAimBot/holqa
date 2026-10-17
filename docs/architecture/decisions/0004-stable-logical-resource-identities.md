# 0004. Stable logical resource identities

- **Status:** Accepted (foundational principle; only identifier validation is implemented)
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

> **Implementation status:** The principle is an accepted design. The only implemented part is identifier validation in `@holqa/core` (`ResourceId`, `parseResourceId`, `isResourceId`, `maxResourceIdLength`). The identifier grammar is an **initial proposal** and may be revised before 1.0. Nothing yet assigns identities to resources, tracks them across deployments, or uses them to bind infrastructure.

## Context

A deployed queue, bucket or schedule outlives any single version of the code that declares it. If the identity of a resource came from a TypeScript property name or a file path, an ordinary refactor such as renaming `orders` to `orderQueue` or moving a file would look like "delete one resource, create another". For durable resources that means data loss: messages in a queue, objects in a bucket.

Handlers have the same problem. Queue consumers, schedule handlers and storage-event handlers need identities that survive refactors, so that delivery state, retries and logs stay attached to the right handler.

Identities also end up in manifests, logs, diagnostics, URLs and provider resource names. That needs a grammar that is safe in all of those places.

## Decision

1. **Every resource and every handler has an explicit, stable logical identifier** (`id`), chosen by the developer.
2. **TypeScript property names, variable names and file paths are never the persistent identity.** In the illustrative `resources: { orders: queue({ id: "order-processing" }) }`, `orders` is a local name for type inference and ergonomics. `order-processing` is the identity.
3. **Changing an `id` is a change of identity.** Future tooling (planned) must treat it as removing one resource and adding another, report it clearly, and never act on it destructively without explicit confirmation ([ADR 0003](0003-explicit-resource-declarations.md)).
4. **Identifiers are validated at the boundary** and represented by a branded type, so an unvalidated string cannot be used where an identity is required.
5. **Logical identifiers are provider-neutral.** A provider binding may derive physical names from them but must not require users to embed provider naming rules.

### Implemented: identifier validation

`@holqa/core` exports:

- `ResourceId`: a branded `string` type.
- `parseResourceId(value: unknown): Result<ResourceId, Diagnostic>`. It never throws. Invalid input produces a diagnostic with code `HOLQA_RESOURCE_ID_INVALID`.
- `isResourceId(value)`: a type guard.
- `maxResourceIdLength`: 63.

The initial grammar is `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$` with a length of 1 to 63. Identifiers start with a lowercase letter and consist of lowercase alphanumeric segments separated by single `-` or `.` characters, for example `order-processing` or `orders.process`. The 63-character limit and the restricted alphabet keep identifiers usable in DNS labels, file names and most provider naming schemes. The `.` separator lets handler identifiers be namespaced, as in `orders.process`. This grammar is a proposal. Whether `.` stays allowed, and whether resources and handlers share one grammar, are open questions to settle before 1.0.

## Consequences

### Positive

- Refactoring TypeScript code cannot accidentally replace infrastructure.
- Identifiers are readable in manifests, logs and diagnostics, and are stable across deployments.
- The brand pushes validation to the boundary. Code that receives a `ResourceId` can rely on its shape.

### Negative

- Developers have to choose and maintain an `id` in addition to a property name. Some boilerplate is accepted for safety.
- Deliberately renaming a durable resource will need an explicit migration path. That is planned and not designed.
- If the grammar changes before 1.0, existing identifiers may become invalid. Keeping the grammar a proposal until then is a deliberate choice.

## Alternatives considered

### Derive the identity from the property name or file path

Rejected. Refactors would silently change identity, which is the failure this ADR exists to prevent.

### Generated identities (UUIDs or content hashes) stored in a state file

Rejected. They are stable, but they are unreadable in logs and diagnostics, and a separate state file must be kept in sync and can be lost. Holqa may still keep deployment state in the future, but keyed by human-chosen identifiers.

### Optional `id` that defaults to the property name

Rejected. The default would quietly reintroduce property-name identity for anyone who omits the `id`.

### Allow arbitrary strings and sanitize per provider

Rejected. Different providers would sanitize differently, so one logical identifier could map to colliding or differing physical names. Validating once in core gives one portable grammar.

## Related

- [`packages/core/src/identity/resource-id.ts`](../../../packages/core/src/identity/resource-id.ts)
- [Diagnostic codes](../../reference/diagnostic-codes.md)
- [Application model](../../concepts/application-model.md)
- [Resource graph](../../concepts/resource-graph.md)
- [ADR 0003: Explicit resource declarations](0003-explicit-resource-declarations.md)
