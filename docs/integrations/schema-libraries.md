# Schema libraries: Zod, Valibot, and Effect Schema

> **Status:** The Zod adapter (`@holqa/zod`) is **Implemented**. Valibot and Effect Schema adapters are **Planned**. See [schema contracts](../reference/schema-contracts.md), [ADR 0016](../architecture/decisions/0016-schema-adapters-and-conversion-fidelity.md) and [ADR 0021](../architecture/decisions/0021-schema-contracts-wire-payloads-and-compatibility.md).

Holqa uses schemas for two purposes: TypeScript type inference and runtime validation at trust boundaries. Its public generics are designed around the Standard Schema interface so that developers can choose their schema library. See [type safety and schemas](../concepts/type-safety-and-schemas.md) for the full model.

## What an adapter does

Standard Schema provides validation and type inference. The compiler also needs a **normalized, portable representation** of each schema. A schema adapter supplies that:

| Responsibility | Example |
| --- | --- |
| Expose input and output types | `z.string().transform(Number)` has input `string`, output `number`. |
| Produce the normalized representation | Object shapes, primitive constraints, enums, arrays, optionality, nullability. |
| Produce JSON Schema metadata | For OpenAPI and generated clients. |
| Report unsupported constructs | Return a problem with a path and a hint, which the normalizer reports as `HOLQA_SCHEMA_UNSUPPORTED`, instead of approximating. |
| Report runtime-only constraints | Refinements, rewrites, coercion and similar constructs, each with a path and a kind. |

Serialization is not the adapter's job: the wire always carries the schema's input form as JSON ([wire payloads](../reference/schema-contracts.md#wire-payloads)).

## Adapters

| Library | Package | Status | Notes |
| --- | --- | --- | --- |
| Zod | `@holqa/zod` (`packages/integrations/zod`) | **Implemented** | Zod 4 classic and Mini. Example code throughout the docs uses Zod. |
| Valibot | `packages/integrations/valibot` | Planned | Implements Standard Schema natively. |
| Effect Schema | `packages/integrations/effect` | Planned | Bundled with the Effect integration ([Effect](effect.md)). Distinguishes encoded and decoded types explicitly, which maps well to Holqa's input/output distinction. |

## Usage

Declaring resources with Zod schemas needs no adapter: validation goes through Standard Schema.

```ts
import { defineApp, queue } from "@holqa/sdk";
import { z } from "zod";

export const app = defineApp({
  name: "commerce",
  resources: {
    orders: queue({
      id: "order-processing",
      message: z.object({
        orderId: z.string(),
        priority: z.enum(["normal", "urgent"])
      }),
      schemaVersion: 1
    })
  }
});
```

Tools that need the portable contract pass the adapter to the normalizer explicitly:

```ts
import { describeSchemaContract } from "@holqa/compiler";
import { zodAdapter } from "@holqa/zod";

const result = await describeSchemaContract(app.resources.orders.message, {
  subject: "message for queue \"order-processing\"",
  schemaVersion: 1,
  adapters: [zodAdapter]
});
```

How the CLI will obtain adapters (declared in `defineApp`, a tool configuration file, or resolved by vendor name) is **Proposed**. Either way, the core packages do not import Zod or any other schema library.

## Supported subset and diagnostics

Each adapter documents exactly which constructs it normalizes. Constructs that run arbitrary code can still be validated at runtime but cannot be described portably, and the outcome is explicit:

| Construct | Runtime validation | Portable description | Outcome |
| --- | --- | --- | --- |
| Object, string, number, boolean, enum, array, optional, nullable, union | Yes | Yes | Supported |
| String formats and length constraints | Yes | Yes | Supported |
| Custom refinement (`.refine(fn)`) | Yes | No | Runtime-only: recorded in the contract, `HOLQA_SCHEMA_RUNTIME_ONLY` warning |
| Transform (`.transform(fn)`) | Yes | Input side only | Wire side described; decoded side recorded as unrepresentable |
| `Date`, `bigint`, `Map`, class instances, functions | No portable form | No | `HOLQA_SCHEMA_UNSUPPORTED` |

The full Zod table is in [schema contracts](../reference/schema-contracts.md#zod-support).

## Related

- [Type safety and schemas](../concepts/type-safety-and-schemas.md)
- [Integrations](index.md)
- [Effect](effect.md)
