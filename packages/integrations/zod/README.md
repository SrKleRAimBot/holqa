# @holqa/zod

> **Status:** **Implemented.** Private and unpublished. Supports Zod 4 (classic `zod` and `zod/mini`).

The Zod schema adapter for Holqa. It turns Zod schemas into Holqa's portable schema contracts and reports exactly what
JSON Schema cannot express, instead of approximating.

Runtime validation does not need this package: Holqa validates any Standard Schema, including Zod's, through
`@holqa/core`. Use the adapter where a portable description is needed, such as normalization, fingerprints and
compatibility checks in `@holqa/compiler`.

```ts
import { describeSchemaContract } from "@holqa/compiler";
import { zodAdapter } from "@holqa/zod";
import { z } from "zod";

const orderPlaced = z.object({ orderId: z.string(), priority: z.enum(["normal", "urgent"]).default("normal") });

const result = await describeSchemaContract(orderPlaced, {
  subject: "message for queue \"orders\"",
  schemaVersion: 1,
  adapters: [zodAdapter]
});
```

## Exports

| Export | Kind | Description |
| --- | --- | --- |
| `zodAdapter` | Constant | The default adapter, recording the installed Zod version as `library` (for example `zod@4.6.7`). |
| `createZodAdapter(options?)` | Function | Creates an adapter, optionally with a custom `library` identifier. Throws when the installed Zod is not version 4. |
| `isZodSchema(value)` | Function | Structural check for Zod 4 schemas (classic or Mini). |
| `zodVendor` | Constant | `"zod"`, the Standard Schema vendor the adapter handles. |
| `ZodAdapterOptions` | Type | `{ library?: string }`. |

## Behavior

- Converts with Zod's own JSON Schema generator (`draft-2020-12`, `unrepresentable: "throw"`) and walks Zod's
  internal definitions to find what that generator drops or misdescribes.
- Refinements, value rewrites (`.trim()`), coercion, `.catch()`, `z.preprocess()` and piped second schemas become
  runtime-only constraints with their JSON path.
- `Date`, `bigint`, `Map`, `Set`, `z.custom()`, promises, files and other non-JSON types on the wire (input) side
  reject the schema with a path and a hint. On the output side they are recorded as unrepresentable.
- A transform's output side is recorded as unrepresentable; the wire (input) side is still described.
- Unknown Zod types fail rather than being guessed.

The full support table, limitations, and how contracts are fingerprinted and compared are in
[schema contracts](../../../docs/reference/schema-contracts.md#zod-support).

## Dependencies

- Peer dependency: `zod` `^4.6.7`.
- Internal: `@holqa/core` only. The adapter is runtime-neutral and imports no Bun or Node APIs.

The adapter reads `_zod.def`, which is not a public Zod API. The tests in `tests/` are the corpus that must pass for every
supported Zod version.
