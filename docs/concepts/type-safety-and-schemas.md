# Type safety and schemas

> **Status:** Proposed — not implemented. Source-based inference and mandatory runtime validation at trust boundaries are accepted direction. Building on Standard Schema with a normalized internal representation is **Proposed** in [ADR 0006](../architecture/decisions/0006-standard-schema-and-portable-schema-representation.md) until validated with Zod and one other library. No schema handling, normalization, or client generation exists yet.

Type safety is one of Holqa's defining characteristics. Holqa connects resources and operations with strict TypeScript types **and** runtime schemas, because static types alone cannot protect data that crosses a process, network, or time boundary.

## Two complementary mechanisms

| Mechanism | Protects against | Limits |
| --- | --- | --- |
| **Static types** (inferred from source) | Mistakes in code you compile together: wrong field names, wrong message shapes, missing handlers. | Cannot see data from other processes, older deployments, or untrusted clients. |
| **Runtime schemas** (validated at trust boundaries) | Malformed or malicious input, messages produced by earlier versions, misconfigured environments. | Cost at runtime; only as good as the schema. |

Holqa uses one schema declaration to drive both.

## Source-based type inference

For code inside the application, types are **inferred directly from source**, not generated.

The following code is illustrative. The API is proposed, not implemented, and may change.

```ts
// infra.ts
const app = defineApp({
  name: "commerce",
  resources: {
    orders: queue({
      id: "order-processing",
      message: z.object({ orderId: z.string(), priority: z.enum(["normal", "urgent"]) }),
      schemaVersion: 1
    })
  }
});
export const resources = app.resources;
```

```ts
// Elsewhere: types flow from the declaration.
await resources.orders.send({ orderId: "o_1", priority: "urgent" }); // OK
await resources.orders.send({ orderId: "o_1", priority: "low" }); // Type error
```

There is no generated `OrdersMessage` interface to keep in sync. Inference from source is preferred because it:

- Updates immediately in the editor, with no build or watch step.
- Cannot drift from the declaration.
- Works with go-to-definition and refactoring tools.

Code generation is still appropriate where consumers **cannot import the source**: browser clients and external API consumers. See [generated clients](#generated-browser-safe-clients).

## Standard Schema

Holqa's public type generics are designed around the [Standard Schema](https://standardschema.dev/) interface rather than being coupled directly to Zod. Standard Schema is a small common interface implemented by Zod, Valibot, Effect Schema (via adapter), and others. It provides:

- Input and output type inference.
- A uniform `validate` function returning a value or issues.

This lets developers use their preferred schema library and lets Holqa's core remain library-neutral.

**Zod** is the planned first-class integration. **Valibot** and **Effect Schema** are planned through adapters. See [schema libraries](../integrations/schema-libraries.md).

## Why Standard Schema alone is insufficient

Standard Schema covers validation and type inference. The compiler and runtime need more:

| Need | Why |
| --- | --- |
| Input vs. decoded-output inference | A schema may transform data (for example a string to a `Date`). Producers send the input type; consumers receive the output type. |
| Runtime validation | At every trust boundary (see below). |
| Explicit serialization and deserialization | Messages cross the wire as bytes. Transformations must round-trip predictably. |
| Portable JSON Schema metadata | For OpenAPI documents, generated clients, and inspection tools. |
| Stable schema fingerprints | To detect when a contract changes between compilations. |
| Schema evolution diagnostics | To warn when a change may break consumers or historical data. |
| Compatibility checking | To compare a new contract against a previously deployed one. |
| Unsupported-schema reporting | To fail explicitly when a schema cannot be represented. |

So Holqa defines a **normalized internal schema representation**: a portable, JSON-serializable description produced from each schema by a library-specific adapter. The compiler stores it in the manifest (serialized with the implemented canonical JSON serializer) and uses it for fingerprints, documentation, and compatibility checks. The exact representation is **Proposed**.

## Honest limits of normalization

Not every schema can be represented faithfully as JSON Schema or any portable format. Examples: arbitrary refinement functions, custom transforms, recursive types with runtime logic, class instances.

Holqa's rule:

> A schema that cannot be safely normalized produces an explicit diagnostic. It is never silently approximated.

The planned code for this is `HOLQA_SCHEMA_UNSUPPORTED` (see [diagnostic codes](../reference/diagnostic-codes.md)). An adapter may support a documented subset fully, mark specific constructs as "validated at runtime but opaque to documentation", or reject them. Which of these applies must be visible to the developer, not guessed.

## Runtime validation at trust boundaries

TypeScript's static type system cannot validate incoming messages, HTTP requests, or historical data. Runtime validation is therefore **mandatory** at trust boundaries:

| Boundary | Validated data |
| --- | --- |
| Incoming HTTP / RPC request | Path and query parameters, headers, body. |
| Queue consumption | Message payload, before the handler runs. |
| Storage events | Event metadata from the provider. |
| Configuration load | Secrets and variables, at application start. |
| Outgoing responses (optional) | Response bodies against declared status-specific schemas. |

Validation failures produce structured diagnostics or well-defined error responses, not thrown strings. Whether producers also validate on `send` (catching bugs earlier at a runtime cost) is a **Proposed** policy decision.

## Generated browser-safe clients

Frontend code cannot import `infra.ts`: it would pull in server code, handler modules, and configuration. Instead, the compiler will generate **browser-safe clients** for public HTTP and RPC contracts (**Planned**, Phase 4 of the [roadmap](../roadmap.md)).

Requirements:

- Clients contain only public contract types, schemas needed for client-side validation, and transport code using the Fetch API.
- Clients never contain handler implementations, internal functions, private resources, credentials, or secrets.
- The client runtime (`@holqa/client`) depends only on `@holqa/core` and must not import Bun or Node APIs. This is enforced by the boundary rules ([package boundaries](../architecture/package-boundaries.md)).
- Generated files are treated as generated output, not hand-maintained source.

Framework integrations such as TanStack Query build on these clients ([TanStack](../integrations/tanstack.md)).

## Compatibility and evolution

Compile-time type correctness does not imply compatibility with data produced by earlier deployments. A queue may hold messages written by the previous version of the producer; a bucket may hold objects from last year; a mobile client may call last month's API.

The future compiler must account for:

| Concern | Planned mechanism |
| --- | --- |
| Versioned messages | Queue declarations carry an explicit `schemaVersion`; messages carry the version they were produced with. |
| Contract change detection | Stable schema fingerprints recorded in the manifest. |
| Breaking-change diagnostics | Compare the new manifest against a previous one and flag removed fields, narrowed types, and changed required-ness. |
| Public HTTP/RPC contract changes | The same comparison for request and response schemas and routes. |
| Migration guidance | Diagnostics with hints, and a public `schema-evolution` agent skill. |

A sophisticated compatibility engine is out of scope for the bootstrap phase; it is listed under Future on the [roadmap](../roadmap.md). The requirement is recorded here so that the manifest format and schema representation are designed to support it.

## TypeScript standards in this repository

Holqa's own code uses strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and more), prefers `unknown` with narrowing over `any`, and uses discriminated unions such as `Result<T, E>` for protocol states. Public generic types require negative type tests. See [ADR 0009](../architecture/decisions/0009-test-placement-and-typescript-standards.md) and [code style](../contributing/code-style.md).

## Related

- [Application model](application-model.md)
- [Schema libraries](../integrations/schema-libraries.md)
- [Compiler](../architecture/compiler.md)
- [Security](security.md)
