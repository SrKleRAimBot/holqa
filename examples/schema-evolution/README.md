# Schema evolution example

> **Status:** **Implemented.** Executed by `pnpm test` and `pnpm check` (and therefore CI).

A private workspace package that exercises Holqa's schema system end to end with Zod, through the packages' public
exports. [`src/orders.ts`](src/orders.ts) declares an `order-placed` message whose wire form carries an ISO timestamp
and whose decoded form carries a `Date`, plus compatible and incompatible later versions.

| Test file | What it shows |
| --- | --- |
| [`tests/wire.test.ts`](tests/wire.test.ts) | One schema validates a message on `queue(...).send` and again in the consumer, with the input type for producers and the decoded output type for consumers. A version 1 message never reaches a version 2 consumer silently: it is rejected by version, or by the failing field. |
| [`tests/contracts.test.ts`](tests/contracts.test.ts) | Reordered but equivalent schemas, and Zod classic versus Zod Mini, share a fingerprint. A `Date` on the wire side is rejected with `HOLQA_SCHEMA_UNSUPPORTED`. An added required field or a removed enum value fails the compatibility check (`HOLQA_SCHEMA_CHANGE_BREAKING`) until the schema version is increased, after which it is reported as `HOLQA_SCHEMA_MIGRATION_REQUIRED`. |

```bash
pnpm turbo run test --filter=@holqa/example-schema-evolution
```

See [schema contracts](../../docs/reference/schema-contracts.md).
