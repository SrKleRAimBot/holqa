# 0018. Typed kind registries in the descriptor protocol

- **Status:** Proposed
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

> **Implementation status:** Implemented in `@holqa/core` by the change that adds this ADR. It refines the descriptor layout of [ADR 0013](0013-descriptor-protocol-in-core.md); it becomes Accepted when a maintainer approves it.

## Context

[ADR 0013](0013-descriptor-protocol-in-core.md) accepted a descriptor protocol in `@holqa/core`. The M0 prototype typed resource descriptors as `{ kind: string; config: JsonObject; schemas: Record<string, StandardSchemaV1> }` and handler descriptors as `{ trigger: { kind: string; resource: string; ... }, config, schemas, invoke }`. Those shapes are open dictionaries: a reader cannot tell from the types which settings a queue has, a typo in a setting name type-checks, and nothing stops provider-specific keys from entering the core model, which [ADR 0005](0005-infrastructure-independent-resource-contracts.md) and the infrastructure-neutrality rules forbid.

The first framework milestone needs a protocol that represents queues, buckets, schedules and HTTP APIs now, and topics, WebSocket endpoints or workflows later, without a new architecture per kind. It also needs the compiler to read a handler's metadata without calling user code.

## Decision

1. `@holqa/core` defines a **resource kind registry**, the `ResourceKindMap` interface. Each entry fixes five typed facets of one kind: `config` (normalized, JSON-only settings), `requirements` (behaviour a binding must guarantee), `schemas` (Standard Schemas by role), `capabilities` (what a binding advertises) and `driver` (data-plane operations, or `never`).
2. `ResourceDescriptorOf<Kind>` is derived from the registry, and `ResourceDescriptor` is the union over all kinds, discriminated by `kind`. Identifiers are branded `ResourceId`s.
3. A **trigger kind registry**, `TriggerKindMap`, does the same for handlers: the resource kind a trigger belongs to, its JSON-only `options`, its `schemas` and the trusted `metadata` a runtime passes per invocation.
4. A handler descriptor separates its **declarative metadata** (`definition: { id, trigger: { kind, resource: { kind, id }, options } }`, plain JSON) from its **executable** `invoke(input, context)`. Tools inspect `definition` and `schemas`; only runtimes call `invoke`. Handler references name the resource by kind and identifier, never by object.
5. Exhaustiveness is checked by the compiler: the list of kinds, the capability comparison per kind and the reader's kind check are all typed as mapped types over the registries, so adding a registry entry without the rest fails to compile.
6. Readers (`getDescriptor` and friends) reject descriptors with another protocol version **or with a kind or trigger kind that their copy of the registry does not define**. Adding a kind is additive within protocol 1; an older reader reports it as unsupported rather than guessing its shape.

## Consequences

### Positive

- Every setting of every kind is typed. Provider configuration bags cannot enter the core model without an explicit, reviewed change to the registry.
- Adding a kind is local: interfaces plus one registry entry, then compile errors point to everything else that needs a decision.
- Handler metadata is JSON data that can be serialized and checked against the resource graph without executing handlers.
- `RuntimeBinding` drivers are derived from the registry, so the binding contract grows with it.

### Negative

- Third-party packages cannot add resource kinds without a change to `@holqa/core`. This is deliberate for now: kinds are part of the protocol.
- The descriptor layout differs from the M0 prototype (`definition` instead of top-level `id`/`trigger`/`config`), so the experiments are not protocol-compatible with `@holqa/core`. The experiments are disposable ([backlog](../../milestones/m0/backlog.md) HB-26).
- Typed facets make the core package larger and every change to a facet a compatibility event for readers.

### Revisit when

- An integration needs its own resource kind (consider declaration merging on the registry interfaces).
- A second authoring front end needs facets the registry cannot express.

## Alternatives considered

### Open `config` dictionaries (the M0 layout)

Rejected: untyped, admits provider-specific keys, and moves every shape check to run time.

### One interface per kind with no registry

Rejected: the union, the binding contract and the readers would each need manual updates per kind, with nothing to catch a missed one.

### Handler descriptors that expose the user callback directly

Rejected: the runtime must validate untrusted input before user code runs, so the executable part is a wrapper (`invoke`), and the declarative part must be readable without touching it.

## Related

- [Resource model architecture](../resource-model.md)
- [ADR 0013: A descriptor protocol in `@holqa/core`](0013-descriptor-protocol-in-core.md)
- [ADR 0005: Infrastructure-independent resource contracts](0005-infrastructure-independent-resource-contracts.md)
