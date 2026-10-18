# Type safety and schemas

> **Status:** Partly implemented. Source-based inference, Standard Schema validation with structured errors, JSON wire payloads, schema normalization through adapters (with `@holqa/zod` as the first), fingerprints and compatibility checks are **Implemented**; see [schema contracts](../reference/schema-contracts.md) and [ADR 0021](../architecture/decisions/0021-schema-contracts-wire-payloads-and-compatibility.md). Recording contracts in a manifest, comparing against a previous deployment, migrations and generated clients are **Planned**.

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

**Zod** is the first-class integration (`@holqa/zod`, **Implemented**). **Valibot** and **Effect Schema** are planned through adapters. See [schema libraries](../integrations/schema-libraries.md).

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

So Holqa defines a **normalized internal schema representation**, the schema contract: a portable, JSON-serializable description produced from each schema by a library-specific adapter. It is JSON Schema draft 2020-12 per side (input and output), plus fidelity, runtime-only constraints and the converter's library version. Normalization, canonical form, fingerprints and compatibility checks are **Implemented** in `@holqa/compiler` ([schema contracts](../reference/schema-contracts.md)). Storing contracts in the manifest is **Planned**.

## Honest limits of normalization

Not every schema can be represented faithfully as JSON Schema or any portable format. Examples: arbitrary refinement functions, custom transforms, recursive types with runtime logic, class instances.

Holqa's rule:

> A schema that cannot be safely normalized produces an explicit diagnostic. It is never silently approximated.

The code for this is `HOLQA_SCHEMA_UNSUPPORTED` (see [diagnostic codes](../reference/diagnostic-codes.md)). An adapter supports a documented subset fully, marks specific constructs as runtime-only (validated at runtime but absent from the description, reported with `HOLQA_SCHEMA_RUNTIME_ONLY`), or rejects them. Which of these applies is visible to the developer, never guessed. The [Zod support table](../reference/schema-contracts.md#zod-support) lists the outcome for each construct.

## Runtime validation at trust boundaries

TypeScript's static type system cannot validate incoming messages, HTTP requests, or historical data. Runtime validation is therefore **mandatory** at trust boundaries:

| Boundary | Validated data |
| --- | --- |
| Incoming HTTP / RPC request | Path and query parameters, headers, body. |
| Queue consumption | Message payload, before the handler runs. |
| Storage events | Event metadata from the provider. |
| Configuration load | Secrets and variables, at application start. |
| Outgoing responses (optional) | Response bodies against declared status-specific schemas. |

Validation failures produce structured diagnostics with the failing field's path (**Implemented**: `InputValidationError`, `HOLQA_INPUT_INVALID`), not thrown strings. Queue producers validate on `send` as well, so the same schema checks a message on publish and on receipt (**Implemented**).

## What crosses the wire

Ordinary payloads are JSON (**Implemented**). Producers send the schema's input form, encoded to an exact JSON copy and validated after encoding; consumers decode it with the same schema. A transformation that produces a `Date` therefore never puts a `Date` on the wire, and a value without a JSON form fails with `HOLQA_PAYLOAD_NOT_SERIALIZABLE` instead of being coerced. Binary data uses explicit payload codecs or buckets. See [wire payloads](../reference/schema-contracts.md#wire-payloads).

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
| Concern | Mechanism | Status |
| --- | --- | --- |
| Versioned messages | Queue declarations carry an explicit `schemaVersion`; the `holqa.message/1` envelope carries the version a message was produced with. | **Implemented** (drivers do not use the envelope yet) |
| Contract change detection | Stable fingerprints over canonical contracts. | **Implemented**; recording them in the manifest is **Planned** |
| Breaking-change diagnostics | `checkSchemaCompatibility` classifies each change as safe, potentially breaking, unverifiable or breaking. | **Implemented**; comparing against a deployed manifest is **Planned** |
| Public HTTP/RPC contract changes | The same checker with the `request` and `response` roles. | **Implemented** as a library function; routes are **Proposed** |
| Migration guidance | Diagnostics with hints, the [evolution guidance](../reference/schema-contracts.md#evolution-guidance), and a public `schema-evolution` agent skill. | Guidance **Implemented**; the skill is available as a preview; migration engine **Planned** |

## TypeScript standards in this repository

Holqa's own code uses strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and more), prefers `unknown` with narrowing over `any`, and uses discriminated unions such as `Result<T, E>` for protocol states. Public generic types require negative type tests. See [ADR 0009](../architecture/decisions/0009-test-placement-and-typescript-standards.md) and [code style](../contributing/code-style.md).

## Related

- [Application model](application-model.md)
- [Schema libraries](../integrations/schema-libraries.md)
- [Compiler](../architecture/compiler.md)
- [Security](security.md)
