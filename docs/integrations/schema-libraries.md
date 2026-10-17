# Schema libraries: Zod, Valibot, and Effect Schema

> **Status:** Planned. No schema adapters exist. Zod is the planned first-class integration; Valibot and Effect Schema are planned through adapters. The underlying design is **Accepted design** in [ADR 0016](../architecture/decisions/0016-schema-adapters-and-conversion-fidelity.md), which supersedes ADR 0006.

Holqa uses schemas for two purposes: TypeScript type inference and runtime validation at trust boundaries. Its public generics are designed around the Standard Schema interface so that developers can choose their schema library. See [type safety and schemas](../concepts/type-safety-and-schemas.md) for the full model.

## What an adapter does

Standard Schema provides validation and type inference. The compiler also needs a **normalized, portable representation** of each schema. A schema adapter supplies that:

| Responsibility | Example |
| --- | --- |
| Expose input and output types | `z.string().transform(Number)` has input `string`, output `number`. |
| Produce the normalized representation | Object shapes, primitive constraints, enums, arrays, optionality, nullability. |
| Produce JSON Schema metadata | For OpenAPI and generated clients. |
| Report unsupported constructs | Emit `HOLQA_SCHEMA_UNSUPPORTED` (planned) with a location and a hint, instead of approximating. |
| Define serialization behavior | How transformed values (dates, big numbers) cross the wire and are decoded. |

## Planned adapters

| Library | Package directory | Priority | Notes |
| --- | --- | --- | --- |
| Zod | `packages/integrations/zod` | First | First-class. Example code throughout the docs uses Zod. |
| Valibot | `packages/integrations/valibot` | Later | Implements Standard Schema natively. |
| Effect Schema | `packages/integrations/effect` | Later | Bundled with the Effect integration ([Effect](effect.md)). Distinguishes encoded and decoded types explicitly, which maps well to Holqa's input/output distinction. |

## Usage pattern

The following code is illustrative. The API is proposed, not implemented, and may change.

```ts
import { defineApp, queue } from "@holqa/sdk";
import { z } from "zod";

export default defineApp({
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

Whether the SDK detects the library automatically through Standard Schema's vendor field or requires explicit adapter registration is **Proposed**. Either way, the core packages must not import Zod or any other schema library.

## Supported subset and diagnostics

Each adapter documents exactly which constructs it normalizes. Constructs that run arbitrary code (custom refinements, transforms) can still be validated at runtime, but cannot be described portably. The adapter must make the outcome explicit:

| Construct | Runtime validation | Portable description | Outcome |
| --- | --- | --- | --- |
| Object, string, number, boolean, enum, array, optional, nullable | Yes | Yes | Supported |
| String formats and length constraints | Yes | Yes | Supported |
| Custom refinement (`.refine(fn)`) | Yes | No | Warning or error depending on context (Proposed) |
| Transform (`.transform(fn)`) | Yes | Input side only | Requires explicit input/output handling (Proposed) |
| Class instances, functions | No portable form | No | `HOLQA_SCHEMA_UNSUPPORTED` |

The exact policy for each row is a design decision for Phase 1 of the [roadmap](../roadmap.md).

## Related

- [Type safety and schemas](../concepts/type-safety-and-schemas.md)
- [Integrations](index.md)
- [Effect](effect.md)
